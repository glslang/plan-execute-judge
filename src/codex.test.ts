import { test } from "node:test";
import assert from "node:assert/strict";
import { codexThreadOptions, toCodexEffort } from "./codex.js";

test("codexThreadOptions maps pipeline settings to an unattended Codex thread", () => {
  assert.deepEqual(
    codexThreadOptions({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      cwd: "/repo",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchEnabled: false,
    }),
    {
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
      workingDirectory: "/repo",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchEnabled: false,
    }
  );
});

test("Codex rejects Claude-only max effort", () => {
  assert.throws(() => toCodexEffort("max"), /use "xhigh"/);
});

test("Codex passes through supported effort levels", () => {
  for (const effort of ["low", "medium", "high", "xhigh"] as const) {
    assert.equal(toCodexEffort(effort), effort);
  }
});
