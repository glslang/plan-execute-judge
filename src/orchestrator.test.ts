import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline, type PipelinePhases } from "./orchestrator.js";
import {
  DEFAULT_CONFIG,
  pipelineArtifactFiles,
  planAgentFile,
  researchAgentFile,
  VerdictSchema,
  type PipelineConfig,
  type Verdict,
} from "./types.js";
import { verdictJsonSchema } from "./judge.js";
import { PIPELINE_STATE_VERSION, savePipelineState } from "./state.js";

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...DEFAULT_CONFIG, task: "add a thing", cwd: makeTempDir(), ...overrides };
}

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pej-orchestrator-"));
  tempDirs.push(dir);
  return dir;
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
    researchOutputFiles: string[];
    planResearch: (string | undefined)[];
    planOutputFiles: string[];
    refinementPlans: string[][];
    refinementResearch: (string | undefined)[];
    approvedPlans: string[];
    executePlans: string[];
    executePriorVerdicts: (Verdict | undefined)[];
    judgePlans: string[];
  } = {
    researchCalls: 0,
    researchOutputFiles: [],
    planResearch: [],
    planOutputFiles: [],
    refinementPlans: [],
    refinementResearch: [],
    approvedPlans: [],
    executePlans: [],
    executePriorVerdicts: [],
    judgePlans: [],
  };
  let judgeCall = 0;
  const phases: PipelinePhases = {
    research: async (cfg, opts) => {
      calls.researchCalls++;
      const brief = opts?.agentCount && opts.agentCount > 1 ? `THE BRIEF ${opts.agentIndex}` : "THE BRIEF";
      const outputFile = opts?.outputFile ?? cfg.researchFile;
      calls.researchOutputFiles.push(outputFile);
      writeFileSync(join(cfg.cwd, outputFile), brief, "utf-8");
      return brief;
    },
    plan: async (cfg, research, opts) => {
      calls.planResearch.push(research);
      const plan = opts?.agentCount && opts.agentCount > 1 ? `THE PLAN ${opts.agentIndex}` : "THE PLAN";
      const outputFile = opts?.outputFile ?? cfg.planFile;
      calls.planOutputFiles.push(outputFile);
      writeFileSync(join(cfg.cwd, outputFile), plan, "utf-8");
      return plan;
    },
    refinements: async (cfg, plans, research) => {
      calls.refinementPlans.push(plans);
      calls.refinementResearch.push(research);
      writeFileSync(join(cfg.cwd, cfg.planFile), "MERGED PLAN", "utf-8");
      return "MERGED PLAN";
    },
    approvePlan: async (_cfg, plan) => {
      calls.approvedPlans.push(plan);
      return "APPROVED PLAN";
    },
    execute: async (_cfg, _plan, priorVerdict) => {
      calls.executePlans.push(_plan);
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

test("runs multiple research agents and feeds the combined brief to plan", async () => {
  const { phases, calls } = makePhases([PASS]);
  const cfg = makeCfg({ research: { sources: ["https://example.com/spec"], userResearch: [] }, researchAgents: 2 });
  const result = await runPipeline(cfg, phases);

  assert.equal(calls.researchCalls, 2);
  assert.deepEqual(calls.researchOutputFiles, [researchAgentFile(cfg, 1), researchAgentFile(cfg, 2)]);
  assert.match(result.research ?? "", /# Research agent 1/);
  assert.match(result.research ?? "", /THE BRIEF 2/);
  assert.deepEqual(calls.planResearch, [result.research]);
  assert.equal(readFileSync(join(cfg.cwd, cfg.researchFile), "utf-8"), result.research);
});

test("runs multiple planning agents and refinements merges their plans", async () => {
  const { phases, calls } = makePhases([PASS]);
  const cfg = makeCfg({ planAgents: 2 });
  const result = await runPipeline(cfg, phases);

  assert.deepEqual(calls.planOutputFiles, [planAgentFile(cfg, 1), planAgentFile(cfg, 2)]);
  assert.deepEqual(calls.refinementPlans, [["THE PLAN 1", "THE PLAN 2"]]);
  assert.deepEqual(calls.executePlans, ["MERGED PLAN"]);
  assert.deepEqual(calls.judgePlans, ["MERGED PLAN"]);
  assert.equal(result.plan, "MERGED PLAN");
  assert.equal(readFileSync(join(cfg.cwd, cfg.planFile), "utf-8"), "MERGED PLAN");
});

test("approval step gates execution and can replace the plan", async () => {
  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline(makeCfg({ planApproval: true }), phases);

  assert.deepEqual(calls.approvedPlans, ["THE PLAN"]);
  assert.deepEqual(calls.executePlans, ["APPROVED PLAN"]);
  assert.deepEqual(calls.judgePlans, ["APPROVED PLAN"]);
  assert.equal(result.plan, "APPROVED PLAN");
});

test("pipelineArtifactFiles reserves the research artifact only when research is configured", () => {
  const base = {
    planFile: "PLAN.md",
    researchFile: "RESEARCH.md",
    stateFile: ".pej-state.json",
    researchAgents: 1,
    planAgents: 1,
  };
  assert.deepEqual(pipelineArtifactFiles({ ...base, research: undefined, researchArtifact: false }), [
    "PLAN.md",
    ".pej-state.json",
  ]);
  assert.deepEqual(
    pipelineArtifactFiles({ ...base, research: { sources: [], userResearch: ["notes.md"] }, researchArtifact: true }),
    ["PLAN.md", "RESEARCH.md", ".pej-state.json"]
  );
});

test("pipelineArtifactFiles reserves multi-agent research and plan artifacts", () => {
  const files = pipelineArtifactFiles({
    planFile: "PLAN.md",
    researchFile: "RESEARCH.md",
    stateFile: ".pej-state.json",
    research: { sources: [], userResearch: ["notes.md"] },
    researchArtifact: true,
    researchAgents: 2,
    planAgents: 2,
  });

  assert.deepEqual(files, [
    "PLAN.md",
    "RESEARCH.md",
    ".pej-state.json",
    "PLAN.agent-1.md",
    "PLAN.agent-2.md",
    "RESEARCH.agent-1.md",
    "RESEARCH.agent-2.md",
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

test("resumes an interrupted execute round from the checkpoint", async () => {
  const cfg = makeCfg();
  const interrupted: PipelinePhases = {
    research: async () => assert.fail("research should be skipped"),
    plan: async (cfg) => {
      writeFileSync(join(cfg.cwd, cfg.planFile), "THE PLAN", "utf-8");
      return "THE PLAN";
    },
    refinements: async () => assert.fail("refinements should not run"),
    approvePlan: async () => assert.fail("approval should not run"),
    execute: async () => {
      throw new Error("usage limit");
    },
    judge: async () => assert.fail("judge should not run after execute fails"),
  };

  await assert.rejects(runPipeline(cfg, interrupted), /usage limit/);
  const state = JSON.parse(readFileSync(join(cfg.cwd, cfg.stateFile), "utf-8"));
  assert.equal(state.phase, "execute");
  assert.equal(state.round, 1);

  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline({ ...cfg, resume: true }, phases);

  assert.equal(result.passed, true);
  assert.deepEqual(calls.planResearch, []);
  assert.deepEqual(calls.executePriorVerdicts, [undefined]);
  assert.deepEqual(calls.judgePlans, ["THE PLAN"]);
  assert.equal(existsSync(join(cfg.cwd, cfg.stateFile)), false);
});

test("resumes at judge after execute completed", async () => {
  const cfg = makeCfg();
  writeFileSync(join(cfg.cwd, cfg.planFile), "THE PLAN", "utf-8");
  savePipelineState(cfg, {
    version: PIPELINE_STATE_VERSION,
    task: cfg.task,
    phase: "judge",
    round: 1,
    baselineRef: cfg.baselineRef,
    researchEnabled: false,
    researchAgents: cfg.researchAgents,
    planAgents: cfg.planAgents,
    planApproval: cfg.planApproval,
    planFile: cfg.planFile,
    researchFile: cfg.researchFile,
  });

  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline({ ...cfg, resume: true }, phases);

  assert.equal(result.passed, true);
  assert.deepEqual(calls.executePriorVerdicts, []);
  assert.deepEqual(calls.judgePlans, ["THE PLAN"]);
});

test("resumes at refinements with existing plan candidates", async () => {
  const cfg = makeCfg({ planAgents: 2 });
  writeFileSync(join(cfg.cwd, planAgentFile(cfg, 1)), "THE PLAN 1", "utf-8");
  writeFileSync(join(cfg.cwd, planAgentFile(cfg, 2)), "THE PLAN 2", "utf-8");
  savePipelineState(cfg, {
    version: PIPELINE_STATE_VERSION,
    task: cfg.task,
    phase: "refinements",
    round: 1,
    baselineRef: cfg.baselineRef,
    researchEnabled: false,
    researchAgents: cfg.researchAgents,
    planAgents: cfg.planAgents,
    planApproval: cfg.planApproval,
    planFile: cfg.planFile,
    researchFile: cfg.researchFile,
  });

  const { phases, calls } = makePhases([PASS]);
  const result = await runPipeline({ ...cfg, resume: true }, phases);

  assert.equal(result.passed, true);
  assert.deepEqual(calls.planOutputFiles, []);
  assert.deepEqual(calls.refinementPlans, [["THE PLAN 1", "THE PLAN 2"]]);
  assert.deepEqual(calls.executePlans, ["MERGED PLAN"]);
});

test("resume requires a checkpoint", async () => {
  const cfg = makeCfg({ resume: true });
  writeFileSync(join(cfg.cwd, cfg.planFile), "THE PLAN", "utf-8");

  const { phases } = makePhases([PASS]);
  await assert.rejects(runPipeline(cfg, phases), /no \.pej-state\.json checkpoint/);
});

test("rejects a non-positive or non-integer maxRounds", async () => {
  for (const maxRounds of [0, -1, 1.5, NaN]) {
    const { phases } = makePhases([PASS]);
    await assert.rejects(runPipeline(makeCfg({ maxRounds }), phases), /maxRounds/);
  }
});

test("rejects non-positive or non-integer agent counts", async () => {
  for (const researchAgents of [0, -1, 1.5, NaN]) {
    const { phases } = makePhases([PASS]);
    await assert.rejects(runPipeline(makeCfg({ researchAgents }), phases), /researchAgents/);
  }
  for (const planAgents of [0, -1, 1.5, NaN]) {
    const { phases } = makePhases([PASS]);
    await assert.rejects(runPipeline(makeCfg({ planAgents }), phases), /planAgents/);
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
