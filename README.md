# plan-execute-judge

Generic plan -> execute -> judge pipeline on the Claude Agent SDK (TypeScript).
Three `query()` calls chained by real control flow. The plan text and a typed
verdict are the only data crossing phase boundaries -- never a conversation
transcript. `PLAN.md` is written as a human-readable artifact of the run.

## Layout

```
src/
  types.ts             PipelineConfig, the Verdict zod schema, defaults
  permissions.ts       Bash-command vetting hook for the read-only phases
  plan.ts              read-only research -> plan text (also saved to PLAN.md)
  execute.ts           implements the plan (or fixes gaps from a prior verdict)
  judge.ts             reviews the tree against plan + task, returns a typed Verdict
  orchestrator.ts      execute -> judge loop, bounded by maxRounds, injectable phases
  index.ts             CLI entry: git preflight, baseline capture, env overrides
  util.ts              drains a query() stream, throws on non-"success" results
  *.test.ts            node:test unit tests (orchestrator loop, command vetting)
```

## Setup

```
npm install
cp .env.example .env   # set ANTHROPIC_API_KEY
npm test               # build + unit tests (needs Node >= 22)
npm start -- "add rate limiting to the /upload endpoint, 10 req/min per IP"
```

Run it from inside the repo you want it to work on, or set `PEJ_TARGET_CWD`.
It must be a git repo -- the CLI refuses to start otherwise, and captures the
current `HEAD` as the baseline the judge diffs against.

Environment overrides: `PEJ_TARGET_CWD` (target repo), `PEJ_MODEL` (all three
phases), `PEJ_MAX_ROUNDS` (execute -> judge cycles, default 3).

## Design decisions worth knowing before you extend this

**Read-only phases run under `permissionMode: "dontAsk"` plus a Bash-vetting
hook.** That mode denies any tool call that isn't in `allowedTools` instead of
prompting for it -- which is what you want in an unattended pipeline, since
there's no human around to answer a prompt. `Write`/`Edit` are denied outright
by the allowlist. Bash stays available (the judge must run `git diff` and the
plan's acceptance-criterion commands), but a `PreToolUse` hook
(`permissions.ts`) denies the common mutation vectors: git subcommands that
write, `rm`/`mv`/`sed -i` and friends, package-manager installs, `curl`/`wget`,
and output redirection. This is deliberate defense-in-depth, not a sandbox --
`node -e` can still write files -- but it stops an agent from drifting into
editing the tree during review.

**The judge never sees execute's transcript.** Each phase is its own `query()`
call with no `resume`, so the judge starts cold with only the plan, the task,
and whatever's on disk -- not execute's narrative of what it did. That's the
part that keeps the judge from rubber-stamping.

**The judge diffs against a baseline ref and enumerates untracked files.**
Plain `git diff` misses new files entirely and shows nothing if the executor
committed. The CLI records `HEAD` at startup; the judge runs
`git status --porcelain` (and reads new files) plus `git diff <baseline>`, so
staged or committed changes stay visible. The execute prompt also forbids
staging/committing, but the baseline makes the review robust if that's ignored.

**The judge checks the task, not just the plan.** The original task is in the
judge's prompt: if the implementation satisfies the plan but the plan missed
part of the task, that's a failing gap. Otherwise a bad plan converges
confidently on the wrong thing.

**The verdict is structured, not prose.** `judge.ts` passes `outputFormat: {
type: "json_schema", schema: verdictJsonSchema }`, so `verdict.pass` is a
real boolean the orchestrator branches on, not something parsed out of a
paragraph. Keep the schema narrow (`pass`, `summary`, `gaps`) -- a free-text
"review" field invites style commentary and scope creep on every round.

**Everything defaults to `claude-opus-4-8`,** with independent overrides
(`planModel` / `executeModel` / `judgeModel`) if you want a cheaper model
judging or planning than the one doing the implementation work.

**Every phase has a turn ceiling** (`maxTurns` in `types.ts`: plan 64,
execute 256, judge 64). A phase that hits it ends with `error_max_turns`,
which `runPhase` turns into a pipeline-stopping error instead of a silent
partial result.

**`settingSources` defaults to `[]`.** No CLAUDE.md, no project hooks, no
skills get loaded for any phase -- each starts genuinely clean. Set it to
`['project']` in `types.ts` (or per-call, if you fork the config) if you want
execute to pick up your repo's conventions.

## Testing

`npm test` compiles and runs the unit tests with node's built-in runner --
no test dependencies. The orchestrator's phases are injectable
(`runPipeline(cfg, phases)`), so the retry loop is tested with fakes: pass on
round one, fail -> fix-up -> pass (asserting the failed verdict reaches the
next execute call), giving up at `maxRounds`, and rejecting `maxRounds < 1`.
`permissions.test.ts` pins the vetting policy with allow/deny cases.

## Extending

- **Per-phase hooks:** add a `PostToolUse` hook to `execute.ts`'s `options`
  that shells out to your test runner and returns `{ continue: false, ... }`
  on failure, so a broken build can't even reach the judge.
- **Parallel judges:** call `runJudge` more than once (e.g. a correctness
  judge and a security judge with different prompts/schemas) and require
  both to pass before returning.
- **CI usage:** this is already headless -- wire `npm start -- "<task>"` into
  a pipeline step and check the exit code; `1` means it didn't pass within
  `maxRounds`.
