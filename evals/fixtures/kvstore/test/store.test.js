import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kvstore-test-"));
  try {
    fn(new Store(join(dir, "kv.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("set then get round-trips a value", () => {
  withStore((store) => {
    store.set("name", "ada");
    assert.equal(store.get("name"), "ada");
  });
});

test("get on a missing key returns undefined", () => {
  withStore((store) => {
    assert.equal(store.get("nope"), undefined);
  });
});

test("delete removes a key and reports whether it existed", () => {
  withStore((store) => {
    store.set("a", "1");
    assert.equal(store.delete("a"), true);
    assert.equal(store.get("a"), undefined);
    assert.equal(store.delete("a"), false);
  });
});

test("keys lists sorted keys", () => {
  withStore((store) => {
    store.set("b", "2");
    store.set("a", "1");
    assert.deepEqual(store.keys(), ["a", "b"]);
  });
});
