import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, DEFAULT_MODELS, effectiveModel, type PipelineConfig } from "./types.js";

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...DEFAULT_CONFIG, task: "test task", cwd: "/repo", ...overrides };
}

test("effectiveModel uses the selected backend default when the global model is still defaulted", () => {
  const cfg = makeCfg({ backend: "claude", model: DEFAULT_MODELS.claude });

  assert.equal(effectiveModel(cfg, "claude"), DEFAULT_MODELS.claude);
  assert.equal(effectiveModel(cfg, "codex"), DEFAULT_MODELS.codex);
});

test("effectiveModel preserves explicit model overrides", () => {
  const cfg = makeCfg({ backend: "claude", model: "custom-model" });

  assert.equal(effectiveModel(cfg, "codex"), "custom-model");
  assert.equal(effectiveModel(cfg, "codex", "phase-model"), "phase-model");
});

test("effectiveModel preserves an explicit model even when it equals a default", () => {
  const cfg = makeCfg({ backend: "claude", model: DEFAULT_MODELS.claude, modelExplicit: true });

  assert.equal(effectiveModel(cfg, "codex"), DEFAULT_MODELS.claude);
});
