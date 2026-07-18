"""Shared harness: load eval tasks, run one pipeline rollout, score it.

A rollout copies a fixture to a temp git repo, runs the Node pipeline against
it (optionally with prompt overrides via PEJ_PROMPTS_FILE), then runs the
task's hidden acceptance check against the resulting worktree. The score mixes
the hidden check (ground truth, dominant), judge/hidden agreement, and a
first-round-pass bonus; the assembled feedback text is what GEPA reflects on.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DIST_ENTRY = REPO_ROOT / "dist" / "index.js"
TASKS_DIR = REPO_ROOT / "evals" / "tasks"
FIXTURES_DIR = REPO_ROOT / "evals" / "fixtures"

INPUT_DATA_PLACEHOLDER = "{{INPUT_DATA}}"

# The hidden check dominates by design; judge agreement and a first-round pass
# add shaping signal without letting the (LLM) judge define success.
W_HIDDEN = 0.7
W_JUDGE_AGREEMENT = 0.15
W_FIRST_ROUND = 0.15

DEFAULT_TASK_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_TASK_EFFORT = "medium"

CHECK_TIMEOUT_S = 300


@dataclass(frozen=True)
class EvalTask:
    id: str
    fixture: str
    split: str
    task: str
    check: str


@dataclass
class RolloutConfig:
    model: str = DEFAULT_TASK_MODEL
    effort: str = DEFAULT_TASK_EFFORT
    max_rounds: int = 2
    timeout_s: int = 1800
    workers: int = 3
    keep_dirs: bool = False


@dataclass
class RolloutResult:
    task: EvalTask
    score: float
    hidden_pass: bool
    pipeline: dict | None  # parsed PEJ_RESULT_FILE payload, None on crash/timeout
    check_output: str
    diffstat: str
    notes: list[str] = field(default_factory=list)
    duration_s: float = 0.0

    @property
    def feedback(self) -> str:
        return build_feedback(self)


def load_tasks(split: str | None = None, ids: list[str] | None = None) -> list[EvalTask]:
    tasks = []
    for path in sorted(TASKS_DIR.glob("*.json")):
        task = EvalTask(**json.loads(path.read_text(encoding="utf-8")))
        if split and split != "all" and task.split != split:
            continue
        if ids and task.id not in ids:
            continue
        tasks.append(task)
    if not tasks:
        raise SystemExit(f"no tasks matched split={split!r} ids={ids!r} under {TASKS_DIR}")
    return tasks


def dump_default_prompts() -> dict[str, str]:
    """Reads the pipeline's default prompt templates out of the Node build."""
    script = (
        f"import({json.dumps((REPO_ROOT / 'dist' / 'prompts.js').as_uri())})"
        ".then(m => console.log(JSON.stringify(m.DEFAULT_PROMPTS)))"
    )
    out = subprocess.run(
        ["node", "-e", script], cwd=REPO_ROOT, capture_output=True, text=True, check=True, timeout=60
    )
    return json.loads(out.stdout)


def compute_score(hidden_pass: bool, pipeline: dict | None, *, head_moved: bool = False) -> float:
    """A run that never produced a pipeline result (crash, timeout, wedged
    phase) scores 0 even if the worktree happens to pass the hidden check:
    optimized prompts must yield runs that complete, and GEPA must never
    retain a mutation that breaks the pipeline itself.

    A give-up run (judge failed maxRounds times, pipeline exited 1 after
    writing its result) is NOT a crash and is scored normally -- e.g. hidden
    pass + judge fail = 0.70 is a deliberate signal about an over-strict
    judge, and the 0.15 agreement term on a hidden failure rewards a judge
    that honestly caught a bad implementation.

    A rollout that moved HEAD scores 0 outright: the execute contract requires
    leaving every change uncommitted, and committing also hides the diff from
    the judge's and this harness's baseline comparison -- a prompt mutation
    that commits must never look attractive to GEPA."""
    if pipeline is None or head_moved:
        return 0.0
    score = 0.0
    if hidden_pass:
        score += W_HIDDEN
    judge_pass = bool(pipeline.get("passed"))
    if judge_pass == hidden_pass:
        score += W_JUDGE_AGREEMENT
    if hidden_pass and judge_pass and pipeline.get("rounds") == 1:
        score += W_FIRST_ROUND
    return round(score, 4)


def validate_prompt_override(text: str) -> str | None:
    """Mirrors the pipeline's own template validation; returns a problem or None."""
    if not isinstance(text, str) or not text.strip():
        return "the template is empty"
    n = text.count(INPUT_DATA_PLACEHOLDER)
    if n != 1:
        return f"the template must contain {INPUT_DATA_PLACEHOLDER} exactly once (found {n})"
    if "{{SOURCE_ACCESS}}" in text:
        return "only the research template may contain {{SOURCE_ACCESS}}"
    return None


def _git(cwd: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)
    return proc.stdout.strip()


def _run_killable(cmd: list[str], env: dict[str, str], timeout_s: int) -> tuple[int | None, str]:
    """Runs cmd in its own process group; on timeout kills the whole group so
    SDK child processes don't linger. Returns (returncode or None, output tail)."""
    proc = subprocess.Popen(
        cmd,
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        out, _ = proc.communicate(timeout=timeout_s)
        return proc.returncode, (out or "")[-2000:]
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, _ = proc.communicate()
        return None, (out or "")[-2000:]


def run_rollout(task: EvalTask, prompt_overrides: dict[str, str] | None, cfg: RolloutConfig) -> RolloutResult:
    start = time.time()
    notes: list[str] = []
    work = Path(tempfile.mkdtemp(prefix=f"pej-{task.id}-"))
    worktree = work / "repo"
    try:
        shutil.copytree(FIXTURES_DIR / task.fixture, worktree)
        _git(worktree, "init", "-q")
        _git(worktree, "config", "user.email", "pej-evals@example.invalid")
        _git(worktree, "config", "user.name", "pej-evals")
        _git(worktree, "add", "-A")
        _git(worktree, "commit", "-q", "-m", "fixture baseline")
        baseline_sha = _git(worktree, "rev-parse", "HEAD")

        result_file = work / "result.json"
        env = {k: v for k, v in os.environ.items() if not k.startswith("PEJ_")}
        env.update(
            {
                "PEJ_TARGET_CWD": str(worktree),
                "PEJ_RESULT_FILE": str(result_file),
                "PEJ_MAX_ROUNDS": str(cfg.max_rounds),
                "PEJ_MODEL": cfg.model,
                "PEJ_EFFORT": cfg.effort,
            }
        )
        if prompt_overrides:
            prompts_file = work / "prompts.json"
            prompts_file.write_text(json.dumps(prompt_overrides, indent=2), encoding="utf-8")
            env["PEJ_PROMPTS_FILE"] = str(prompts_file)

        code, tail = _run_killable(["node", str(DIST_ENTRY), task.task], env, cfg.timeout_s)
        if code is None:
            notes.append(f"pipeline timed out after {cfg.timeout_s}s and was killed")
        elif code != 0:
            notes.append(f"pipeline exited with code {code}")
        if code != 0 and tail:
            notes.append(f"pipeline output tail:\n{tail}")

        pipeline: dict | None = None
        if result_file.exists():
            try:
                pipeline = json.loads(result_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                notes.append("result file exists but is not valid JSON")

        # A hanging import/CLI in the generated code must fail this rollout,
        # not raise through the executor and abort the whole optimization run.
        try:
            check = subprocess.run(
                ["node", str(REPO_ROOT / task.check), str(worktree)],
                capture_output=True,
                text=True,
                timeout=CHECK_TIMEOUT_S,
            )
            hidden_pass = check.returncode == 0
            check_output = ((check.stdout or "") + (check.stderr or "")).strip()
        except subprocess.TimeoutExpired as err:
            hidden_pass = False
            partial = (err.stdout or b"").decode(errors="replace") if isinstance(err.stdout, bytes) else (err.stdout or "")
            check_output = (
                f"hidden check timed out after {CHECK_TIMEOUT_S}s -- an import or command in the "
                f"modified code appears to hang\npartial output:\n{partial[-500:]}"
            )
            notes.append(f"hidden check timed out after {CHECK_TIMEOUT_S}s")

        # Diff against the recorded baseline SHA, not HEAD: an executor that
        # commits its changes moves HEAD and would otherwise show a clean diff.
        diff = subprocess.run(
            ["git", "-C", str(worktree), "diff", baseline_sha, "--stat"], capture_output=True, text=True
        )
        status = subprocess.run(
            ["git", "-C", str(worktree), "status", "--porcelain", "--untracked-files=all"],
            capture_output=True,
            text=True,
        )
        diffstat = (diff.stdout.strip() + "\nuntracked/status:\n" + status.stdout.strip()).strip()

        head_moved = _git(worktree, "rev-parse", "HEAD") != baseline_sha
        score = compute_score(hidden_pass, pipeline, head_moved=head_moved)
        if head_moved:
            notes.append(
                "scored 0: the run committed changes (HEAD moved from the fixture baseline); "
                "the execute contract requires leaving every change uncommitted"
            )
        elif pipeline is None:
            notes.append("scored 0: the pipeline produced no result file, regardless of worktree state")

        return RolloutResult(
            task=task,
            score=score,
            hidden_pass=hidden_pass,
            pipeline=pipeline,
            check_output=check_output,
            diffstat=diffstat,
            notes=notes,
            duration_s=round(time.time() - start, 1),
        )
    finally:
        if cfg.keep_dirs:
            print(f"[keep] {task.id}: {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


def run_rollouts(
    tasks: list[EvalTask], prompt_overrides: dict[str, str] | None, cfg: RolloutConfig
) -> list[RolloutResult]:
    with ThreadPoolExecutor(max_workers=cfg.workers) as pool:
        return list(pool.map(lambda t: run_rollout(t, prompt_overrides, cfg), tasks))


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated, {len(text) - limit} more chars]"


def build_feedback(r: RolloutResult) -> str:
    lines = [
        f"Task {r.task.id} ({r.task.fixture} fixture): {r.task.task}",
        f"Score {r.score:.2f}; hidden acceptance check {'PASSED' if r.hidden_pass else 'FAILED'}.",
    ]
    if r.pipeline is None:
        lines.append("Pipeline produced no result file (crash or timeout), so no judge verdict exists.")
    else:
        lines.append(
            f"Pipeline judge verdict: {'PASS' if r.pipeline.get('passed') else 'FAIL'} "
            f"after {r.pipeline.get('rounds')} round(s) "
            f"({'agrees' if bool(r.pipeline.get('passed')) == r.hidden_pass else 'DISAGREES'} with the hidden check)."
        )
        for i, v in enumerate(r.pipeline.get("verdicts", []), 1):
            lines.append(f"  round {i}: {'PASS' if v.get('pass') else 'FAIL'} -- {v.get('summary', '')}")
            for gap in v.get("gaps", []):
                lines.append(f"    gap [{gap.get('kind')}] {gap.get('requirement')}: {gap.get('issue')}")
    for note in r.notes:
        lines.append(f"Note: {note}")
    lines.append("Hidden check output (ground truth on what is still wrong):")
    lines.append(_truncate(r.check_output, 1500))
    lines.append("Working-tree changes (diffstat + status):")
    lines.append(_truncate(r.diffstat, 800))
    return "\n".join(lines)


def summary_table(results: list[RolloutResult]) -> str:
    header = f"{'task':<18} {'score':>5} {'hidden':>6} {'judge':>6} {'rounds':>6} {'secs':>6}"
    rows = [header, "-" * len(header)]
    for r in results:
        judge = "-" if r.pipeline is None else ("pass" if r.pipeline.get("passed") else "fail")
        rounds = "-" if r.pipeline is None else str(r.pipeline.get("rounds"))
        rows.append(
            f"{r.task.id:<18} {r.score:>5.2f} {('pass' if r.hidden_pass else 'fail'):>6} "
            f"{judge:>6} {rounds:>6} {r.duration_s:>6.0f}"
        )
    mean = sum(r.score for r in results) / len(results)
    rows.append(f"mean score: {mean:.3f}  hidden pass rate: {sum(r.hidden_pass for r in results)}/{len(results)}")
    return "\n".join(rows)
