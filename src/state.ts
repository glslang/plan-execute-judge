import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { AGENT_BACKENDS, VerdictSchema, type PipelineConfig, type ResearchConfig } from "./types.js";
import { PromptTemplatesSchema } from "./prompts.js";

export class ResumeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeStateError";
  }
}

export const PIPELINE_STATE_VERSION = 1;

export const PipelinePhaseSchema = z.enum(["research", "plan", "refinements", "approve_plan", "execute", "judge"]);
export type PipelinePhase = z.infer<typeof PipelinePhaseSchema>;

const ResearchConfigSchema: z.ZodType<ResearchConfig> = z.object({
  sources: z.array(z.string()),
  userResearch: z.array(z.string()),
});
const AgentBackendSchema = z.enum(AGENT_BACKENDS);

export const PipelineStateSchema = z.object({
  version: z.literal(PIPELINE_STATE_VERSION),
  task: z.string(),
  phase: PipelinePhaseSchema,
  round: z.number().int().positive(),
  baselineRef: z.string().optional(),
  backend: AgentBackendSchema.optional(),
  model: z.string().optional(),
  modelExplicit: z.boolean().optional(),
  researchEnabled: z.boolean(),
  research: ResearchConfigSchema.optional(),
  researchAgents: z.number().int().positive().default(1),
  researchBackends: z.array(AgentBackendSchema).optional(),
  planAgents: z.number().int().positive().default(1),
  planBackends: z.array(AgentBackendSchema).optional(),
  planApproval: z.boolean().default(false),
  planFile: z.string(),
  researchFile: z.string(),
  // Optional for checkpoints written before prompts were externalized; a
  // resume without it falls back to re-resolving from the environment.
  prompts: PromptTemplatesSchema.optional(),
  lastVerdict: VerdictSchema.optional(),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export function pipelineStatePath(cwd: string, stateFile: string): string {
  return resolve(cwd, stateFile);
}

export function loadPipelineState(cwd: string, stateFile: string): PipelineState | undefined {
  const path = pipelineStatePath(cwd, stateFile);
  if (!existsSync(path)) return undefined;

  try {
    return PipelineStateSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    throw new ResumeStateError(`Invalid pipeline resume state at ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

export function savePipelineState(cfg: PipelineConfig, state: PipelineState): void {
  const path = pipelineStatePath(cfg.cwd, cfg.stateFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function clearPipelineState(cfg: PipelineConfig): void {
  rmSync(pipelineStatePath(cfg.cwd, cfg.stateFile), { force: true });
}
