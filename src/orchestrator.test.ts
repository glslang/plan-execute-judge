import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, type PipelinePhases } from "./orchestrator.js";
import { DEFAULT_CONFIG, pipelineArtifactFiles, VerdictSchema, type PipelineConfig, type Verdict } from "./types.js";
import { verdictJsonSchema } from "./judge.js";

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...DEFAULT_CONFIG, task: "add a thing", cwd: ".", ...overrides };
}

const PASS: Verdict = { pass: true, summary: "all criteria met", gaps: [] };
const FAIL: Verdict = {
  pass: false,
  summary: "one criterion unmet",
  gaps: [{ kind: "implementation_gap", requirement: "step 2", issue: "empty-input test missing" }],
};

/** Phase fakes that record how they were called. */
function makePhases(verdicts: Verdict[]) {
  const calls: {
    researchCalls: number;
    planResearch: (string | undefined)[];
    executePriorVerdicts: (Verdict | undefined)[];
    judgePlans: string[];
  } = {
    researchCalls: 0,
    planResearch: [],
    executePriorVerdicts: [],
    judgePlans: [],
  };
  let judgeCall = 0;
  const phases: PipelinePhases = {
    research: async () => {
      calls.researchCalls++;
      return "THE BRIEF";
    },
    plan: async (_cfg, research) => {
      calls.planResearch.push(research);
      return "THE PLAN";
    },
    execute: async (_cfg, _plan, priorVerdict) => {
      calls.executePriorVerdicts.push(priorVerdict);
    },
    judge: async (_cfg, plan) => {
      calls.judgePlans.push(plan);
      return verdicts[Math.min(judgeCall++, verdicts.length - 1)];
    },
  };
  return { phases, calls };
}

test("passes on the first round", async () => {
  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline(makeCfg(), phases);

  assert.equal(result.passed, true);
  assert.equal(result.rounds, 1);
  assert.equal(result.plan, "THE PLAN");
  assert.deepEqual(result.finalVerdict, PASS);
  assert.deepEqual(calls.executePriorVerdicts, [undefined]);
  assert.deepEqual(calls.judgePlans, ["THE PLAN"]);
});

test("skips research when cfg.research is unset", async () => {
  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline(makeCfg(), phases);

  assert.equal(calls.researchCalls, 0);
  assert.deepEqual(calls.planResearch, [undefined]);
  assert.equal(result.research, undefined);
});

test("runs research before plan when configured and feeds the brief to plan", async () => {
  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline(
    makeCfg({ research: { sources: ["https://example.com/spec"], userResearch: [] } }),
    phases
  );

  assert.equal(calls.researchCalls, 1);
  assert.deepEqual(calls.planResearch, ["THE BRIEF"]);
  assert.equal(result.research, "THE BRIEF");
  assert.equal(result.passed, true);
});

test("pipelineArtifactFiles reserves the research artifact only when research is configured", () => {
  const base = { planFile: "PLAN.md", researchFile: "RESEARCH.md" };
  assert.deepEqual(pipelineArtifactFiles({ ...base, research: undefined }), ["PLAN.md"]);
  assert.deepEqual(pipelineArtifactFiles({ ...base, research: { sources: [], userResearch: ["notes.md"] } }), [
    "PLAN.md",
    "RESEARCH.md",
  ]);
});

test("feeds the failed verdict into the next execute round", async () => {
  const { phases, calls } = makePhases([FAIL, PASS]);
  const result = await runPipeline(makeCfg(), phases);

  assert.equal(result.passed, true);
  assert.equal(result.rounds, 2);
  // Round 1 starts clean; round 2 gets the failing verdict's gaps.
  assert.deepEqual(calls.executePriorVerdicts, [undefined, FAIL]);
});

test("gives up after maxRounds and reports the last verdict", async () => {
  const { phases, calls } = makePhases([FAIL]);
  const result = await runPipeline(makeCfg({ maxRounds: 2 }), phases);

  assert.equal(result.passed, false);
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.finalVerdict, FAIL);
  assert.equal(calls.executePriorVerdicts.length, 2);
});

test("rejects a non-positive or non-integer maxRounds", async () => {
  for (const maxRounds of [0, -1, 1.5, NaN]) {
    const { phases } = makePhases([PASS]);
    await assert.rejects(runPipeline(makeCfg({ maxRounds }), phases), /maxRounds/);
  }
});

test("verdict JSON schema carries no $schema meta-key", () => {
  // zod v4's toJSONSchema emits one; the Agent SDK silently drops
  // structured_output when it's present (found by live smoke test).
  assert.equal("$schema" in verdictJsonSchema, false);
  assert.equal((verdictJsonSchema as Record<string, unknown>).type, "object");
});

test("VerdictSchema accepts a valid verdict and rejects malformed ones", () => {
  assert.deepEqual(VerdictSchema.parse(FAIL), FAIL);
  assert.throws(() => VerdictSchema.parse({ summary: "no pass field", gaps: [] }));
  assert.throws(() => VerdictSchema.parse({ pass: true, summary: "bad gaps", gaps: [{ requirement: "r" }] }));
  assert.throws(() =>
    VerdictSchema.parse({
      pass: true,
      summary: "pass cannot carry gaps",
      gaps: [{ kind: "implementation_gap", requirement: "step 1", issue: "still broken" }],
    })
  );
  assert.throws(() => VerdictSchema.parse({ pass: false, summary: "fail needs a gap", gaps: [] }));
});
