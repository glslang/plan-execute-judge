import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.js";

test("parses --key value pairs", () => {
  assert.deepEqual(parse(["--name", "ada"]), { flags: { name: "ada" }, positionals: [] });
});

test("parses --key=value pairs", () => {
  assert.deepEqual(parse(["--name=ada"]), { flags: { name: "ada" }, positionals: [] });
});

test("bare flags become true", () => {
  assert.deepEqual(parse(["--verbose"]), { flags: { verbose: true }, positionals: [] });
});

test("collects positionals in order", () => {
  assert.deepEqual(parse(["a", "--x", "1", "b"]), { flags: { x: "1" }, positionals: ["a", "b"] });
});

test("empty argv parses to empty result", () => {
  assert.deepEqual(parse([]), { flags: {}, positionals: [] });
});
