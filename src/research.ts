import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { effectiveModel, type AgentBackend, type PipelineConfig } from "./types.js";
import { runPhase } from "./util.js";
import { researchBashHook } from "./permissions.js";
import { serializePromptData } from "./prompt.js";
import { loadPromptTemplates, renderPrompt } from "./prompts.js";
import { runCodexPhase } from "./codex.js";

export interface ResearchRunOptions {
  agentIndex?: number;
  agentCount?: number;
  outputFile?: string;
  backend?: AgentBackend;
}

/**
 * Optional deep-research phase, run before planning when cfg.research is set.
 * Ingests the configured sources -- local documents (including PDFs, via the
 * Read tool), web pages (WebFetch/WebSearch), git/GitHub repositories
 * (cloned into a scratch dir), and remote documents (downloaded into the
 * same scratch dir) -- and builds on the user's own research notes instead
 * of re-deriving them. Produces a self-contained research brief that the
 * plan phase receives; like the plan, the brief crosses the phase boundary
 * in memory and is written to cfg.researchFile only as a human-readable
 * artifact.
 *
 * The scratch dir is the only place this phase may write, enforced by the
 * research Bash policy (permissions.ts), and it is deleted when the phase
 * ends -- the target tree stays untouched until execute.
 */
export async function runResearch(cfg: PipelineConfig, opts: ResearchRunOptions = {}): Promise<string> {
  if (!cfg.research) {
    throw new Error("runResearch called without cfg.research");
  }

  const agentIndex = opts.agentIndex ?? 1;
  const agentCount = opts.agentCount ?? 1;
  const label = agentCount > 1 ? `research ${agentIndex}/${agentCount}` : "research";
  const outputFile = opts.outputFile ?? cfg.researchFile;
  const backend = opts.backend ?? cfg.backend;

  const scratchDir = mkdtempSync(join(tmpdir(), "pej-research-"));
  try {
    const inputData = serializePromptData({
      task: cfg.task,
      sources: cfg.research.sources,
      userResearch: cfg.research.userResearch,
      scratchDir,
      agentIndex,
      agentCount,
    });

    const sourceAccess =
      backend === "codex"
        ? `- Local files (PDFs, markdown, and other documents) with the available read-only shell and file tools.
- Web pages, repository URLs, and remote documents with web search and direct browsing. The Codex phase runs in a read-only sandbox, so do not try to clone or download them.`
        : `- Local files (PDFs, markdown, anything readable) with the Read tool -- it
  handles PDF paths directly.
- Web pages with WebFetch. Use WebSearch when a source needs surrounding
  context or leaves a load-bearing question open.
- git/GitHub repository URLs by cloning into the scratch directory:
  \`git clone --depth=1 <url> <scratchDir>/<name>\` -- then explore the clone
  with Read/Grep/Glob. Always pass an explicit destination under
  "scratchDir"; clones anywhere else are denied.
- Remote PDFs and other documents by downloading into the scratch directory:
  \`curl -L -o <scratchDir>/<name> <url>\` -- then Read the downloaded file.
  Downloads anywhere else are denied.`;

    const prompt = renderPrompt(loadPromptTemplates().research, { inputData, sourceAccess });

    let brief: string;
    if (backend === "codex") {
      brief = await runCodexPhase({
        label,
        prompt,
        model: effectiveModel(cfg, backend, cfg.researchModel),
        effort: cfg.effort,
        cwd: cfg.cwd,
        sandboxMode: "read-only",
        networkAccessEnabled: true,
        webSearchEnabled: true,
        timeoutMs: cfg.codexPhaseTimeoutMs,
        verbose: true,
      });
    } else {
      const stream = query({
        prompt,
        options: {
          model: effectiveModel(cfg, backend, cfg.researchModel),
          effort: cfg.effort,
          cwd: cfg.cwd,
          permissionMode: "dontAsk",
          allowedTools: cfg.researchAllowedTools,
          settingSources: cfg.settingSources,
          maxTurns: cfg.maxTurns.research,
          hooks: { PreToolUse: researchBashHook(label, scratchDir) },
        },
      });
      const result = await runPhase(stream, { label, verbose: true });
      brief = result.result;
    }
    writeFileSync(resolve(cfg.cwd, outputFile), brief, "utf-8");
    return brief;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
