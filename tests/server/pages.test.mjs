import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPages } from "../../scripts/build-pages.mjs";

test("Pages publishes only the public introduction and two brand assets", () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-pages-"));
  try {
    const output = join(directory, "site");
    buildPages(output);
    assert.deepEqual(readdirSync(output).sort(), [".nojekyll", "brand", "index.html"]);
    assert.deepEqual(readdirSync(join(output, "brand")).sort(), ["infinity-ribbon.webp", "xlab-mark.webp"]);
    const html = readFileSync(join(output, "index.html"), "utf8");
    assert.match(html, /x-lab\.game\.elliotttzhang\.cn/);
    assert.match(html, /校网/);
    assert.match(html, /不能在此注册或答题/);
    assert.doesNotMatch(html, /<form\b|\/api\/|src\/server|ADMIN_PASSWORD_HASH/);
    assert.doesNotMatch(html, /地点地点地点/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
