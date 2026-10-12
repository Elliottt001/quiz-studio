import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { newPlatformFixture } from "../platform/helpers.mjs";
import { buildPlatform } from "../../scripts/build-platform.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";

export async function withBrowserFixture(run) {
  const { pool, close } = await newPlatformFixture();
  const staticDir = mkdtempSync(join(tmpdir(), "quiz-browser-assets-"));
  buildPlatform(resolve("public/platform"), staticDir);
  const app = buildPlatformApp({ pool, staticDir, autoSettle: false });
  const base = await app.listen(0);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    return await run({ pool, browser, base });
  } finally {
    if (browser) await browser.close();
    await app.close();
    await close();
    rmSync(staticDir, { recursive: true, force: true });
  }
}
