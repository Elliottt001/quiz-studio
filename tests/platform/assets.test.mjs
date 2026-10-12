import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPlatform } from "../../scripts/build-platform.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("platform static mode refuses an unbuilt entry without affecting API-only mode", async () => {
  const { pool, close } = await newPlatformFixture();
  const output = mkdtempSync(join(tmpdir(), "quiz-platform-unbuilt-"));
  const staticApp = buildPlatformApp({ pool, staticDir: output });
  const apiOnly = buildPlatformApp({ pool, autoSettle: false });
  try {
    await assert.rejects(staticApp.listen(0), /缺少.*构建/);
    const base = await apiOnly.listen(0);
    assert.equal((await fetch(base + "/v2/health")).status, 200);
  } finally {
    await apiOnly.close();
    await close();
    rmSync(output, { recursive: true, force: true });
  }
});

test("Chinese pixel assets are same-origin, versioned and path-contained", async () => {
  const { pool, close } = await newPlatformFixture();
  const parent = mkdtempSync(join(tmpdir(), "quiz-platform-assets-"));
  const output = join(parent, "built");
  buildPlatform(resolve("public/platform"), output);
  const manifest = JSON.parse(readFileSync(join(output, "assets.json"), "utf8"));
  const app = buildPlatformApp({ pool, staticDir: output, autoSettle: false });
  const base = await app.listen(0);
  try {
    for (const path of ["/", "/organizer", "/g/quiz-night"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const html = await response.text();
      assert.match(html, /lang="zh-CN"/);
      assert.equal(html.includes("X-Lab"), false);
      assert.match(html, /\/platform\/assets\/[a-f0-9]{12}\//);
    }
    assert.match(manifest.font,
      /^\/platform\/assets\/[a-f0-9]{12}\/fonts\/fusion-pixel-zh-hans\.woff2$/);
    const theme = await fetch(base + manifest.theme);
    assert.equal(theme.status, 200);
    assert.match(theme.headers.get("cache-control"), /immutable/);
    const css = await theme.text();
    assert.match(css, /fusion-pixel-zh-hans\.woff2/);
    assert.match(css, /font-display:\s*swap/);
    assert.match(css, /PingFang SC/);
    const font = await fetch(base + manifest.font);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal((await font.arrayBuffer()).byteLength > 1000, true);
    const vendor = await fetch(base + manifest.nes);
    assert.equal(vendor.status, 200);
    assert.match(await vendor.text(), /\.nes-btn/);
    for (const license of manifest.licenses) {
      assert.equal((await fetch(base + license)).status, 200);
    }
    assert.notEqual((await fetch(base + "/platform/%2e%2e/package.json")).status, 200);
    assert.equal((await fetch(base + "/platform/%ZZ")).status, 400);
    const health = await fetch(base + "/v2/health");
    assert.equal(health.headers.get("cache-control"), "no-store");
  } finally {
    await app.close();
    await close();
    rmSync(parent, { recursive: true, force: true });
  }
});
