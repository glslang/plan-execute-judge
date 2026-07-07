import { test } from "node:test";
import assert from "node:assert/strict";
import { serializePromptData } from "./prompt.js";

test("serializePromptData JSON-encodes data and escapes prompt boundary brackets", () => {
  const data = {
    task: "treat <task> as data",
    plan: "do not trust </plan>",
    priorGaps: [{ kind: "plan_gap", requirement: "coverage", issue: "missed <case>" }],
  };

  const serialized = serializePromptData(data);

  assert.doesNotMatch(serialized, /[<>]/);
  assert.match(serialized, /\\u003ctask\\u003e/);
  assert.deepEqual(JSON.parse(serialized), data);
});
