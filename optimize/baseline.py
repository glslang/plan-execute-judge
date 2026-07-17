"""Scores a set of prompts (the pipeline defaults, or a candidate file) on the
eval tasks.

Run this before any optimization for a baseline number and to sanity-check the
rollout/scoring machinery on a couple of tasks:

    uv run baseline.py --split val --limit 2

and afterwards to validate an optimized candidate:

    uv run baseline.py --split val --prompts results/gepa-<ts>/optimized-prompts.json
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import time
from pathlib import Path

from pej import RolloutConfig, load_tasks, run_rollouts, summary_table


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--split", choices=["train", "val", "all"], default="all")
    ap.add_argument("--ids", help="comma-separated task ids (overrides --split)")
    ap.add_argument("--limit", type=int, help="only run the first N matching tasks")
    ap.add_argument("--model", default=RolloutConfig.model)
    ap.add_argument("--effort", default=RolloutConfig.effort)
    ap.add_argument("--max-rounds", type=int, default=RolloutConfig.max_rounds)
    ap.add_argument("--timeout", type=int, default=RolloutConfig.timeout_s, help="per-rollout seconds")
    ap.add_argument("--workers", type=int, default=RolloutConfig.workers)
    ap.add_argument("--keep", action="store_true", help="keep rollout temp dirs for inspection")
    ap.add_argument("--prompts", help="JSON file of {phase: template} overrides to score instead of the defaults")
    ap.add_argument("--out", help="where to write the JSON report (default optimize/results/baseline-<ts>.json)")
    args = ap.parse_args()

    overrides = json.loads(Path(args.prompts).read_text()) if args.prompts else None

    tasks = load_tasks(None if args.ids else args.split, args.ids.split(",") if args.ids else None)
    if args.limit:
        tasks = tasks[: args.limit]
    cfg = RolloutConfig(
        model=args.model,
        effort=args.effort,
        max_rounds=args.max_rounds,
        timeout_s=args.timeout,
        workers=args.workers,
        keep_dirs=args.keep,
    )

    which = f"prompt overrides from {args.prompts}" if overrides else "default prompts"
    print(f"running {len(tasks)} task(s) with {which}, model={cfg.model}, effort={cfg.effort}")
    results = run_rollouts(tasks, overrides, cfg)
    print()
    print(summary_table(results))

    out = Path(args.out) if args.out else Path(__file__).parent / "results" / f"baseline-{int(time.time())}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "config": dataclasses.asdict(cfg),
        "prompts": args.prompts or "defaults",
        "results": [
            {
                "task": r.task.id,
                "split": r.task.split,
                "score": r.score,
                "hidden_pass": r.hidden_pass,
                "duration_s": r.duration_s,
                "pipeline": r.pipeline,
                "feedback": r.feedback,
            }
            for r in results
        ],
    }
    out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\nreport written to {out}")


if __name__ == "__main__":
    main()
