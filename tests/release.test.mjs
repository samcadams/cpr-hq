import { test } from "node:test";
import assert from "node:assert/strict";
import { isShipped, releaseManifest } from "../tools/release.mjs";

test("isShipped: module files and folders ship", () => {
  for ( const rel of ["module.json", "README.md", "LICENSE", "lang/en.json", "scripts/main.mjs", "styles/cpr-hq.css",
    "templates/partials/pips.hbs", "packs/hq-macros/000005.ldb", "packs/hq-macros/CURRENT"] ) {
    assert.equal(isShipped(rel), true, rel);
  }
});

test("isShipped: dev files stay out", () => {
  for ( const rel of ["packs/_source/macro.json", "tools/release.mjs", "tests/content.test.mjs", "package.json",
    "package-lock.json", ".gitignore", "node_modules/x/index.js"] ) {
    assert.equal(isShipped(rel), false, rel);
  }
});

test("releaseManifest stamps the URLs from the version", () => {
  const m = releaseManifest({ id: "cpr-hq", version: "1.2.3" });
  const repo = "https://github.com/samcadams/cpr-hq";
  assert.equal(m.id, "cpr-hq");
  assert.equal(m.url, repo);
  assert.equal(m.bugs, `${repo}/issues`);
  assert.equal(m.manifest, `${repo}/releases/latest/download/module.json`);
  assert.equal(m.download, `${repo}/releases/download/v1.2.3/cpr-hq.zip`);
});
