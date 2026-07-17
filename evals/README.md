# Evals

Benchmark tasks for measuring (and optimizing) the pipeline's prompts against
ground truth the pipeline never sees. Used by the GEPA harness in `optimize/`;
see `docs/prompt-optimization.md` for the full design.

## Layout

- `fixtures/<name>/` — tiny dependency-free Node projects the pipeline is run
  against. No `.git` is committed; a harness copies a fixture to a temp
  directory and runs `git init && git add -A && git commit` there so the
  pipeline's clean-tree preflight passes. Each fixture's own committed test
  suite passes as-is (any seeded bugs live in untested behavior).
- `tasks/<id>.json` — one task per file:
  `{ id, fixture, split: "train" | "val", task, check }`. The `task` string is
  exactly what the pipeline receives; it never mentions the check.
- `checks/<id>.mjs` — the hidden acceptance script for a task. Run as
  `node evals/checks/<id>.mjs <worktree-dir>` **after** the pipeline finishes;
  exits 0 iff the task is actually solved. Every check also re-runs the
  fixture's own test suite to catch regressions. Check output is intentionally
  descriptive: it doubles as reflection feedback for the prompt optimizer.

Checks live outside the fixture on purpose: they are ground truth for scoring,
so the pipeline (and the judge especially) must never read them — otherwise
optimization would just teach the prompts to game the metric.

## Adding a task

1. Pick or add a fixture. Keep it dependency-free so rollouts stay fast.
2. Write `tasks/<id>.json` with a natural task description and a `split`.
3. Write `checks/<id>.mjs` using the helpers in `checks/_util.mjs`; make
   failure messages say expected vs. actual. Pass the fixture's pristine test
   count to `fixtureTestsStillPass({ baselineTests })` — every task's contract
   includes adding test coverage, and the helper asserts the suite actually
   grew (argsy: 5, slugger: 4, kvstore: 4).
4. Sanity-check both directions: the check must fail against the pristine
   fixture and pass against a hand-made solution.
