# plan-execute-judge

[![CI](https://github.com/glslang/plan-execute-judge/actions/workflows/ci.yml/badge.svg)](https://github.com/glslang/plan-execute-judge/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.9-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Claude Agent SDK](https://img.shields.io/badge/Claude%20Agent%20SDK-0.3-D97757?logo=anthropic&logoColor=white)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
[![Codex SDK](https://img.shields.io/badge/Codex%20SDK-0.144-111827?logo=openai&logoColor=white)](https://www.npmjs.com/package/@openai/codex-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

Generic plan -> execute -> judge pipeline for the Claude Agent SDK or Codex SDK
(TypeScript), with an optional deep-research phase in front. Research and
planning can fan out across multiple independent agents; when multiple plans
are produced, a `refinements` phase merges them into one final plan. Fresh
agent runs with real control flow. The research brief, the plan text, and a
typed verdict are the only data crossing phase boundaries -- never a
conversation transcript. `RESEARCH.md` and `PLAN.md` are written as
human-readable artifacts of the run.

```
task ─┬─> [research, optional] ingests PDFs, web pages, git repos + your own
      │       notes ─> research brief (saved to RESEARCH.md)
      │                     │
      v                     v
      plan (read-only research) ─> candidate plan(s)
                                          │
            ┌─────────────────────────────┘
            v
      [refinements, when needed] merge candidate plans -> PLAN.md
            |
            v
      [approval, optional] user verifies/agrees to PLAN.md
            |
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
npm run build:bun # bundled Bun build to dist-bun/ (requires Bun)
```

The default Claude backend authenticates, in order of least effort:

- **Machine already logged into Claude Code** -- nothing to do; the Agent SDK
  picks up the same credentials.
- **API key in the environment** -- `export ANTHROPIC_API_KEY=sk-ant-...`
- **API key in a file** -- `cp .env.example .env` and set the key there; the
  start script loads it via Node's `--env-file-if-exists`.

For the Codex backend, either sign in once with `codex login` or provide
`CODEX_API_KEY` in the environment or `.env`.

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
PEJ_BACKEND=claude \
PEJ_MODEL=claude-sonnet-5 \
PEJ_EFFORT=high \
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

| Env var                | Meaning                                                          | Default           |
| ---------------------- | ---------------------------------------------------------------- | ----------------- |
| `PEJ_TARGET_CWD`       | Repo the pipeline works on                                       | current directory |
| `PEJ_BACKEND`          | Agent runtime (`claude` or `codex`)                              | `claude`          |
| `PEJ_MODEL`            | Model id for every phase                                         | backend-specific  |
| `PEJ_EFFORT`           | Reasoning effort (`low`, `medium`, `high`, `xhigh`; Claude also supports `max`) | `high` |
| `PEJ_RESUME`           | Resume an interrupted run from `.pej-state.json`/artifacts       | `0`               |
| `PEJ_CODEX_TIMEOUT_MS` | Abort a stuck Codex phase after this many milliseconds           | `1800000`         |
| `PEJ_RESEARCH_AGENTS`  | Independent research agents when research is enabled             | `1`               |
| `PEJ_PLAN_AGENTS`      | Independent planning agents before `refinements`                 | `1`               |
| `PEJ_PLAN_APPROVAL`    | Require a human to approve `PLAN.md` before execute              | `0`               |
| `PEJ_MAX_ROUNDS`       | Execute -> judge cycles before giving up                         | `3`               |
| `PEJ_RESEARCH_SOURCES` | Comma-separated research sources (URLs, git repos, PDFs/docs)    | unset             |
| `PEJ_RESEARCH_NOTES`   | Comma-separated files of research you've already done            | unset             |

The Claude model default remains `claude-opus-4-8`; Codex defaults to
`gpt-5.6-sol`. Model ids are passed through to the selected SDK. For example:

```sh
PEJ_BACKEND=codex PEJ_MODEL=gpt-5.6-sol PEJ_EFFORT=xhigh \
npm start -- "implement the task"
```

Codex runs research and planning in its read-only sandbox, and execution in its
workspace-write sandbox. Codex judging also uses workspace-write so normal
build/test acceptance commands can create generated outputs, while the judge
prompt still forbids source, dependency, pipeline-artifact, or git-state
mutation. The verdict schema is supplied as structured output. Each phase
starts a fresh Codex thread, matching the pipeline's no-transcript-sharing
design.

### Multi-agent research, planning, and refinements

Set `PEJ_RESEARCH_AGENTS` and/or `PEJ_PLAN_AGENTS` above `1` to run
independent read-only agents for those phases:

```sh
PEJ_RESEARCH_AGENTS=2 PEJ_PLAN_AGENTS=3 \
npm start -- "implement the task"
```

Multiple research agents write `RESEARCH.agent-1.md`, `RESEARCH.agent-2.md`,
and so on, then the pipeline writes a combined `RESEARCH.md` for planning.
Multiple planning agents write `PLAN.agent-1.md`, `PLAN.agent-2.md`, and so on.
The `refinements` phase then compares those candidate plans, resolves
conflicts, and writes the final `PLAN.md` consumed by execute and judge.

Set `PEJ_PLAN_APPROVAL=1` to pause after the final plan is written. The CLI
prints the plan, waits for a human to type `yes`, and rereads `PLAN.md` before
execute so you can edit the plan during the pause. This requires interactive
stdin; in noninteractive CI it fails instead of executing an unapproved plan.

### Resuming an interrupted run

Each run writes `.pej-state.json` before and after every phase. If a phase
stops for an external reason, such as a Codex usage-limit error during
`execute`, rerun the same task with `PEJ_RESUME=1` after the limit resets:

```sh
PEJ_RESUME=1 PEJ_BACKEND=codex PEJ_MODEL=gpt-5.6-sol PEJ_EFFORT=xhigh \
npm start -- "implement the task"
```

Resume mode requires `.pej-state.json`; a stale `PEJ_RESUME=1` fails before the
clean-tree guard is relaxed. It skips completed phases, reuses `PLAN.md`,
`RESEARCH.md`, and any multi-agent candidate artifacts named by the checkpoint,
and allows the dirty working tree left by a partial execute. If `execute`
failed, it runs execute again against the partial tree. If `execute` finished
and `judge` failed, it resumes at judge instead of rerunning execute. On a
successful pass, the checkpoint is removed.

Per-phase overrides (`researchModel` / `planModel` / `refinementsModel` /
`executeModel` / `judgeModel`, `maxTurns`, allowed tools) live in
`src/types.ts` if you're forking the config.

### The optional research phase

Setting `PEJ_RESEARCH_SOURCES` and/or `PEJ_RESEARCH_NOTES` (or `research` in
`PipelineConfig`) inserts a deep-research phase before planning:

```sh
PEJ_RESEARCH_SOURCES="https://docs.stripe.com/webhooks,https://github.com/stripe/stripe-node,~/refs/webhook-spec.pdf" \
PEJ_RESEARCH_NOTES="~/notes/stripe-findings.md" \
npm start -- "verify Stripe webhook signatures on /hooks/stripe"
```

It ingests each source by type -- local PDFs and documents via the `Read`
tool (which handles PDFs natively), web pages via `WebFetch`/`WebSearch`,
git/GitHub repositories by shallow-cloning into a throwaway scratch
directory, and remote PDFs by downloading into that same scratch dir. Your
own notes in `PEJ_RESEARCH_NOTES` are treated as trusted prior research: the
phase builds on and verifies them against the sources instead of re-deriving
them, and flags contradictions. The output is a self-contained research brief
(saved to `RESEARCH.md`) that the plan phase grounds its plan in. Local
source and note paths are validated at preflight, so a typo'd path fails
before any tokens are spent.

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

**Claude plan and judge run under `permissionMode: "dontAsk"` plus a
Bash-vetting hook.** That mode denies any tool call that isn't in
`allowedTools` instead of prompting for it -- which is what you want in an
unattended pipeline, since there's no human around to answer a prompt.
`Write`/`Edit` are denied outright by the allowlist. Bash stays available (the
judge must run `git diff` and the plan's acceptance-criterion commands), but a
`PreToolUse` hook
(`permissions.ts`) denies the common mutation vectors: git subcommands that
write, `rm`/`mv`/`sed -i` and friends, package-manager installs, `curl`/`wget`,
and output redirection. This is deliberate defense-in-depth, not a sandbox --
`node -e` can still write files -- but it stops an agent from drifting into
editing the tree during review.

**Research can fetch, but only into a scratch directory.** The research phase
needs the network (WebFetch/WebSearch are in its `allowedTools`) and needs to
materialize repos and remote documents somewhere. It gets a third Bash policy:
everything the read-only policy allows, plus `git clone`, `curl -o`/`wget -O`,
and `mkdir` -- vetted so every destination path is inside a throwaway
`mkdtemp` scratch dir that is deleted when the phase ends. Because curl and
wget have too many file-writing flags to deny one by one (`-O`, `-D`,
`--trace`, `--libcurl`, clustered shorts like `-OJ`, ...), their research
vetting is an allow-list: the scratch-dir output flag plus a few known
non-writing flags, everything else denied. Clones are allow-listed the same
way -- git has clone options that execute commands before the first fetch
(`-c core.sshCommand=...`, `--upload-pack`, `ext::` pseudo-URLs) -- so only
the plain `git clone [safe flags] <https/git/ssh url> <dest-under-scratch>`
shape passes. Scratch-dir paths are canonicalized against symlinks planted
by a cloned repo -- and because all segments of a chained command are vetted
before the first one runs, further writes chained after a `git clone` in the
same command are denied (a separate command re-vets with the clone's symlinks
now visible). Command/process substitution (`$(...)`, backticks) is denied in
every guarded phase, since it executes before any token-level vet can see it.
Env-var prefixes on git/curl/wget are denied in the research phase too --
`GIT_TRACE=<path>` and similar variables write files wherever they point --
and the `env` command runner is denied in every guarded phase, since options
like `env -i`/`env -C` smuggle the real command past token-level vetting.
For the same reason, shell-state and launcher commands (`export`, `eval`,
`bash -c`, `xargs`, `timeout`, ...) are denied in the read-only and research
policies (execute keeps them for `export NODE_ENV=test; npm test` style check
runs), and `find`'s `-exec`/`-delete` flags are denied everywhere. Output
redirection stays denied even into the scratch dir.

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

**The backend defaults to Claude with `claude-opus-4-8` at `high` effort.** Set
`PEJ_BACKEND=codex` to use Codex (default model `gpt-5.6-sol`), with global
overrides via `PEJ_MODEL` and `PEJ_EFFORT`, and independent model overrides
(`researchModel` / `planModel` / `refinementsModel` / `executeModel` /
`judgeModel`) if you want a cheaper model judging or planning than the one
doing the implementation work.

**Every Claude phase has a turn ceiling** (`maxTurns` in `types.ts`: research
128, plan 64, refinements 64, execute 256, judge 64). A phase that hits it ends
with `error_max_turns`, which `runPhase` turns into a pipeline-stopping error
instead of a silent partial result.

**`settingSources` defaults to `[]`.** No CLAUDE.md, no project hooks, no
skills get loaded for any phase -- each starts genuinely clean. Set it to
`['project']` in `types.ts` (or per-call, if you fork the config) if you want
execute to pick up your repo's conventions.

## Testing

`npm test` compiles and runs the unit tests with node's built-in runner --
no test dependencies. The orchestrator's phases are injectable
(`runPipeline(cfg, phases)`), so the retry loop is tested with fakes: pass on
round one, multi-agent research and planning, refinements, approval, fail ->
fix-up -> pass (asserting the failed verdict reaches the next execute call),
giving up at `maxRounds`, and rejecting invalid round/agent counts.
`permissions.test.ts` pins the vetting policies with allow/deny cases,
including the research policy's scratch-dir-scoped clone/download exceptions.
`preflight.test.ts` covers CLI validation, clean committed repos, dirty tracked
and untracked files, no-`HEAD` repos, and research source/note validation. `prompt.test.ts` pins the serialized
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
  types.ts             PipelineConfig, ResearchConfig, the Verdict zod schema, defaults
  permissions.ts       Bash-command vetting hooks: read-only, execute, and research policies
  prompt.ts            serialized prompt data helper
  research.ts          optional deep research over sources + user notes -> brief (RESEARCH.md)
  plan.ts              read-only research -> plan candidate(s)
  refinements.ts       merges multiple plan candidates into the final PLAN.md
  approval.ts          optional human approval gate before execute
  execute.ts           implements the plan (or fixes gaps from a prior verdict)
  judge.ts             reviews the tree against plan + task, returns a typed Verdict
  orchestrator.ts      research/plan fan-out, refinements, approval, execute -> judge loop
  state.ts             resumable phase checkpoint schema and file helpers
  preflight.ts         CLI validation: git preflight, clean-tree check, env parsing
  index.ts             CLI entry: baseline capture, env overrides
  util.ts              drains a query() stream, throws on non-"success" results
  *.test.ts            node:test unit tests (orchestrator loop, command vetting)
```

## License

[MIT](LICENSE)
