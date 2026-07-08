# plan-execute-judge

[![CI](https://github.com/glslang/plan-execute-judge/actions/workflows/ci.yml/badge.svg)](https://github.com/glslang/plan-execute-judge/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.9-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Claude Agent SDK](https://img.shields.io/badge/Claude%20Agent%20SDK-0.3-D97757?logo=anthropic&logoColor=white)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

Generic plan -> execute -> judge pipeline on the Claude Agent SDK (TypeScript).
Three `query()` calls chained by real control flow. The plan text and a typed
verdict are the only data crossing phase boundaries -- never a conversation
transcript. `PLAN.md` is written as a human-readable artifact of the run.

```
task ─> plan (read-only research) ─> plan text (saved to PLAN.md)
                                          │
            ┌─────────────────────────────┘
            v
      execute (acceptEdits -- implements the plan, leaves changes uncommitted)
            │
            v
      judge (read-only -- diffs vs baseline, re-runs every acceptance criterion)
            │  typed verdict { pass, summary, gaps[{ kind, requirement, issue }] }
            ├─ pass ─> exit 0
            └─ fail ─> gaps feed the next execute round ─> ... ─> exit 1 after maxRounds
```

## Setup

```
npm install
npm test          # build + unit tests (needs Node >= 22.9)
```

Authentication, in order of least effort:

- **Machine already logged into Claude Code** -- nothing to do; the Agent SDK
  picks up the same credentials.
- **API key in the environment** -- `export ANTHROPIC_API_KEY=sk-ant-...`
- **API key in a file** -- `cp .env.example .env` and set the key there; the
  start script loads it via Node's `--env-file-if-exists`.

## Usage

### CLI

Run it from inside the repo you want it to work on, or point `PEJ_TARGET_CWD`
at one. The target must be a git repo -- the CLI refuses to start otherwise,
and records `HEAD` as the baseline the judge diffs against. If the target repo
already has commits, it must start with a clean working tree, including no
untracked files. Dirty repos fail before planning so existing changes cannot be
confused with pipeline output. Fresh repos with no `HEAD` are still supported;
for those, the clean-tree check is skipped.

```sh
cd ~/code/my-service
node ~/tools/plan-execute-judge/dist/index.js \
  "add rate limiting to the /upload endpoint, 10 req/min per IP"
```

or, from this repo's own directory:

```sh
PEJ_TARGET_CWD=~/code/my-service \
PEJ_MODEL=claude-sonnet-5 \
PEJ_MAX_ROUNDS=2 \
npm start -- "add rate limiting to the /upload endpoint, 10 req/min per IP"
```

Each phase streams its text as it works. A passing run ends like this (real
output from a scratch-repo run):

```
[plan] written to PLAN.md

[execute] round 1/3
...

[judge] round 1/3
...

[judge] PASS -- Implementation matches the plan exactly: multiply() added and
exported in calc.js, test added in calc.test.js, and all three acceptance
criteria pass verbatim as specified.

Done in 1 round(s).
```

Exit code `0` means the judge passed; `1` means it didn't pass within
`maxRounds`, the CLI/preflight validation failed, or another phase-stopping
error occurred. On retry exhaustion, the last verdict's summary and gaps are
printed to stderr. Changes are left **uncommitted** in the target's working tree
for you to review -- the pipeline never commits.

| Env var          | Meaning                                   | Default             |
| ---------------- | ----------------------------------------- | ------------------- |
| `PEJ_TARGET_CWD` | Repo the pipeline works on                | current directory   |
| `PEJ_MODEL`      | Model for all three phases                | `claude-opus-4-8`   |
| `PEJ_MAX_ROUNDS` | Execute -> judge cycles before giving up  | `3`                 |

Per-phase overrides (`planModel` / `executeModel` / `judgeModel`, `maxTurns`,
allowed tools) live in `src/types.ts` if you're forking the config.

### From Claude Code

Inside an interactive Claude Code session in the target repo, run it as a
one-off with the `!` prefix:

```
! PEJ_TARGET_CWD=. npm --prefix ~/tools/plan-execute-judge start -- "add rate limiting to the /upload endpoint, 10 req/min per IP"
```

Or wire it up as a slash command so it reads as a first-class verb. Create
`.claude/commands/pej.md` in the target repo:

```markdown
---
description: Run the plan-execute-judge pipeline on a task
allowed-tools: Bash(npm --prefix *)
---
Run this and stream its output:

    PEJ_TARGET_CWD=. npm --prefix ~/tools/plan-execute-judge start -- "$ARGUMENTS"

When it finishes, summarize the verdict: pass/fail, rounds used, and any
gaps, then show `git status --short` so I can review the uncommitted changes.
```

then:

```
/pej add rate limiting to the /upload endpoint, 10 req/min per IP
```

The pipeline spawns its own headless agent sessions (it's built on the same
runtime Claude Code uses), so running it from inside a session is just a
subprocess -- credentials are inherited, and your interactive session stays
free while it works.

## Design decisions worth knowing before you extend this

**Plan and judge run under `permissionMode: "dontAsk"` plus a Bash-vetting
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

**Execute can edit files, but Bash is check-only.** The execute phase runs with
`permissionMode: "acceptEdits"` and may use `Write`/`Edit`, so planned file
changes can be made directly. Its Bash hook uses the same guard surface as the
read-only phases: inspection and test commands such as `git diff`, `npm test`,
`pytest`, and `cargo test` are allowed; git state mutation, dependency
mutation, network fetches, shell file mutation commands, `sed -i`, and output
redirection to files are denied.

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
"review" field invites style commentary and scope creep on every round. Each
gap has `kind`, `requirement`, and `issue`: `implementation_gap` means execute
should fix work that missed the plan or checks, while `plan_gap` means the plan
missed part of the original task and execute should treat it as a narrow
task-level amendment. Passing verdicts must have `gaps: []`; failing verdicts
must include at least one gap. One sharp edge, found by live smoke test: the
SDK silently drops `structured_output` if the schema carries the `$schema`
meta-key zod emits, so `judge.ts` strips it (and a unit test pins that).

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
`preflight.test.ts` covers CLI validation, clean committed repos, dirty tracked
and untracked files, and no-`HEAD` repos. `prompt.test.ts` pins the serialized
prompt data escaping used at phase boundaries.

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
- **Deferred hardening:** structured plan schemas and run artifact directories
  are intentionally out of scope for this pass. `PLAN.md` remains the default
  human-readable plan artifact.

## Layout

```
src/
  types.ts             PipelineConfig, the Verdict zod schema, defaults
  permissions.ts       Bash-command vetting hooks for read-only and execute phases
  prompt.ts            serialized prompt data helper
  plan.ts              read-only research -> plan text (also saved to PLAN.md)
  execute.ts           implements the plan (or fixes gaps from a prior verdict)
  judge.ts             reviews the tree against plan + task, returns a typed Verdict
  orchestrator.ts      execute -> judge loop, bounded by maxRounds, injectable phases
  preflight.ts         CLI validation: git preflight, clean-tree check, env parsing
  index.ts             CLI entry: baseline capture, env overrides
  util.ts              drains a query() stream, throws on non-"success" results
  *.test.ts            node:test unit tests (orchestrator loop, command vetting)
```
