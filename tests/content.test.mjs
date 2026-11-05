import { test } from "node:test";
import assert from "node:assert/strict";
import { hasContentFile, parseContent } from "../scripts/content.mjs";

test("hasContentFile finds the file in the folder", () => {
  assert.equal(hasContentFile("content", ["content/other.json", "content/cpr-hq.json"]), true);
});

test("hasContentFile: missing file", () => {
  assert.equal(hasContentFile("content", ["content/other.json"]), false);
  assert.equal(hasContentFile("content", ["elsewhere/cpr-hq.json"]), false);
});

test("hasContentFile decodes URL-encoded paths", () => {
  assert.equal(hasContentFile("my content", ["my%20content/cpr-hq.json"]), true);
});

test("hasContentFile trims slashes on the folder", () => {
  assert.equal(hasContentFile("/content/", ["content/cpr-hq.json"]), true);
});

test("hasContentFile: empty folder never matches", () => {
  assert.equal(hasContentFile("", ["cpr-hq.json", "/cpr-hq.json"]), false);
  assert.equal(hasContentFile(null, ["cpr-hq.json"]), false);
});

test("parseContent returns a plain object", () => {
  const data = { CPRHQ: { Housing: { crammed: "Text" } } };
  assert.deepEqual(parseContent(JSON.stringify(data)), data);
});

test("parseContent rejects arrays, garbage and null", () => {
  assert.equal(parseContent("[1, 2]"), null);
  assert.equal(parseContent("{ not json"), null);
  assert.equal(parseContent("null"), null);
  assert.equal(parseContent("42"), null);
  assert.equal(parseContent(undefined), null);
});
