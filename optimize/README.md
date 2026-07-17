# optimize/ — GEPA prompt-optimization harness

Optimizes the pipeline's prompt templates (default: **plan** + **execute**)
with [GEPA](https://github.com/gepa-ai/gepa) against the benchmark in
`evals/`. Each metric call is one full pipeline run on a fixture task, scored
by that task's hidden acceptance check — ground truth the pipeline never sees.
Design and rationale: `docs/prompt-optimization.md`.

## Setup

Requires [uv](https://docs.astral.sh/uv/) (provisions Python >= 3.10 and the
`gepa` dependency automatically) plus a built pipeline:

```sh
npm run build          # harness invokes node dist/index.js
cd optimize
uv sync
```

Auth: rollouts use whatever the pipeline uses (logged-in Claude Code or
`ANTHROPIC_API_KEY`). Reflection defaults to the `claude` CLI with the same
login; pass `--reflection-lm <litellm-id>` to use litellm + API key instead.

## Usage

```sh
# 1. Baseline: score the current default prompts (start with 2 tasks)
uv run baseline.py --split val --limit 2
uv run baseline.py --split all

# 2. Micro GEPA smoke run (~10 rollouts, 2 train tasks, no val)
uv run run_gepa.py --budget 10 --ids slug-collapse,kv-delete-exit --no-val

# 3. Real run (~150-200 rollouts; low tens of dollars at haiku/medium)
uv run run_gepa.py --budget 150

# 4. Validate the winner at the production config on the val split
uv run baseline.py --split val --prompts results/gepa-<ts>/optimized-prompts.json \
  --model claude-opus-4-8 --effort high
```

## Cost controls

- Task model defaults to `claude-haiku-4-5-20251001` at `medium` effort with
  `PEJ_MAX_ROUNDS=2`; fixtures are dependency-free so rollouts run in minutes.
- `--workers` bounds parallel rollouts (default 3).
- `run_dir` checkpoints GEPA state: re-running with `--run-dir <same>` resumes,
  and touching a `gepa.stop` file in it stops the run gracefully.
- Prompts optimized at a small model may not transfer perfectly to the
  production model — always re-validate the winner at production config.
