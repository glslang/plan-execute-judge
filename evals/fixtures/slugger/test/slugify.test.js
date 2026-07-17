import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lowercases and hyphenates words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("drops punctuation", () => {
  assert.equal(slugify("hello, world!"), "hello-world");
});

test("trims surrounding whitespace", () => {
  assert.equal(slugify("  hello  "), "hello");
});

test("keeps digits", () => {
  assert.equal(slugify("area 51"), "area-51");
});
