import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_JUDGE_SANDBOX_MODE } from "./judge.js";

test("Codex judge uses workspace-write so verification commands can write build outputs", () => {
  assert.equal(CODEX_JUDGE_SANDBOX_MODE, "workspace-write");
});

