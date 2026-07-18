"""Runs GEPA over the pipeline's prompt templates.

The seed candidate is the pipeline's current default prompts (read from the
Node build); each metric call is one full pipeline rollout scored against the
hidden checks. Start with a micro run to prove the loop, then spend a real
budget:

    uv run run_gepa.py --budget 10 --ids slug-collapse,kv-delete-exit   # smoke
    uv run run_gepa.py --budget 150                                     # real

Reflection uses the `claude` CLI (logged-in credentials) by default; pass
--reflection-lm <litellm-model-id> to use litellm with an API key instead.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import subprocess
import time
from pathlib import Path

import gepa

from adapter import PejAdapter
from pej import RolloutConfig, dump_default_prompts, load_tasks

DEFAULT_REFLECTION_MODEL = "claude-opus-4-8"


def claude_cli_reflection(model: str):
    """Reflection LM as a callable backed by `claude -p`, so the harness works
    with a logged-in Claude Code machine and no API key."""

    def call(prompt: str) -> str:
        proc = subprocess.run(
            ["claude", "-p", "--model", model],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"claude -p failed (exit {proc.returncode}): {proc.stderr[-500:]}")
        return proc.stdout

    return call


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--budget", type=int, default=150, help="max metric calls (= pipeline rollouts)")
    ap.add_argument("--components", default="plan,execute", help="which phase prompts to optimize")
    ap.add_argument("--ids", help="comma-separated train task ids (default: the whole train split)")
    ap.add_argument("--no-val", action="store_true", help="skip the val split (micro smoke runs)")
    ap.add_argument("--model", default=RolloutConfig.model, help="pipeline task model")
    ap.add_argument("--effort", default=RolloutConfig.effort)
    ap.add_argument("--max-rounds", type=int, default=RolloutConfig.max_rounds)
    ap.add_argument("--timeout", type=int, default=RolloutConfig.timeout_s, help="per-rollout seconds")
    ap.add_argument("--workers", type=int, default=RolloutConfig.workers)
    ap.add_argument("--reflection-lm", help="litellm model id; default is the claude CLI")
    ap.add_argument("--reflection-model", default=DEFAULT_REFLECTION_MODEL, help="model for the claude CLI reflector")
    ap.add_argument("--run-dir", help="GEPA state dir (resumable); default optimize/results/gepa-<ts>")
    args = ap.parse_args()

    components = [c.strip() for c in args.components.split(",") if c.strip()]
    if not components:
        raise SystemExit("--components must select at least one of: plan, execute")
    unsupported = set(components) - {"plan", "execute"}
    if unsupported:
        raise SystemExit(
            f"cannot optimize {sorted(unsupported)}: research needs {{{{SOURCE_ACCESS}}}} handling; "
            "refinements never runs in these rollouts (multi-plan fan-out via PEJ_PLAN_AGENTS is not "
            "wired into RolloutConfig yet), so its mutations would be scored as noise; and the judge "
            "contributes score terms (agreement + first-round bonus), so optimizing it against them is "
            "circular until a labeled-verdict dataset exists -- see docs/prompt-optimization.md"
        )

    defaults = dump_default_prompts()
    seed_candidate = {c: defaults[c] for c in components}
    # --ids stays within the train split: a val task in the trainset would be
    # reflected on, silently contaminating the held-out score.
    if args.ids:
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        trainset = load_tasks("train", ids)
        missing = set(ids) - {t.id for t in trainset}
        if missing:
            raise SystemExit(f"--ids must name train-split tasks; not in the train split: {sorted(missing)}")
    else:
        trainset = load_tasks("train")
    valset = None if args.no_val else load_tasks("val")

    cfg = RolloutConfig(
        model=args.model,
        effort=args.effort,
        max_rounds=args.max_rounds,
        timeout_s=args.timeout,
        workers=args.workers,
    )
    run_dir = Path(args.run_dir) if args.run_dir else Path(__file__).parent / "results" / f"gepa-{int(time.time())}"
    run_dir.mkdir(parents=True, exist_ok=True)

    reflection_lm = args.reflection_lm or claude_cli_reflection(args.reflection_model)
    print(
        f"GEPA: components={components} budget={args.budget} train={len(trainset)} "
        f"val={len(valset) if valset else 0} model={cfg.model}/{cfg.effort} run_dir={run_dir}"
    )

    result = gepa.optimize(
        seed_candidate=seed_candidate,
        trainset=trainset,
        valset=valset,
        adapter=PejAdapter(cfg),
        reflection_lm=reflection_lm,
        max_metric_calls=args.budget,
        run_dir=str(run_dir),
    )

    best = result.best_candidate
    (run_dir / "optimized-prompts.json").write_text(json.dumps(best, indent=2) + "\n", encoding="utf-8")

    report = [
        "# GEPA run report",
        "",
        f"- components: {components}",
        f"- budget (metric calls): {args.budget}",
        f"- task model/effort: {cfg.model} / {cfg.effort}",
        f"- rollout config: {dataclasses.asdict(cfg)}",
        f"- train tasks: {[t.id for t in trainset]}",
        f"- val tasks: {[t.id for t in valset] if valset else '(none)'}",
        "",
    ]
    val_scores = getattr(result, "val_aggregate_scores", None)
    if val_scores:
        best_idx = getattr(result, "best_idx", None)
        report.append(f"- seed val score: {val_scores[0]:.3f}")
        if best_idx is not None:
            report.append(f"- best val score: {val_scores[best_idx]:.3f} (candidate {best_idx} of {len(val_scores)})")
    report += [
        "",
        "Best candidate written to optimized-prompts.json; use it with:",
        "",
        f"    PEJ_PROMPTS_FILE={run_dir / 'optimized-prompts.json'} node dist/index.js \"<task>\"",
        "",
    ]
    (run_dir / "report.md").write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    print(f"artifacts in {run_dir}")


if __name__ == "__main__":
    main()
