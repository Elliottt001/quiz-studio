import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/server/db.mjs";
import { buildApp } from "../../src/server/app.mjs";
import { buildAssets } from "../../scripts/build.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("health is reachable and the database survives reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-test-"));
  directories.push(directory);
  const path = join(directory, "game.sqlite");
  const db = openDb(path);
  const app = buildApp(db, () => 1_000);
  const address = await app.listen(0, "127.0.0.1");
  const response = await fetch(`${address}/api/health`);
  assert.deepEqual(await response.json(), { ok: true });
  await app.close();
  db.close();
  const reopened = openDb(path);
  assert.equal(reopened.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  reopened.close();
});

test("the server serves the same local entry page to a browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-static-"));
  directories.push(directory);
  const db = openDb(join(directory, "game.sqlite"));
  const app = buildApp(db, () => 1_000);
  const address = await app.listen(0, "127.0.0.1");
  try {
    const response = await fetch(address);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /X-Lab/);
  } finally {
    await app.close();
    db.close();
  }
});

test("the build copies local assets without changing the source", () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-build-"));
  directories.push(directory);
  const source = join(directory, "public");
  const output = join(directory, "dist");
  mkdirSync(source);
  writeFileSync(join(source, "index.html"), "<main>X-Lab</main>");
  buildAssets(source, output);
  assert.equal(readFileSync(join(output, "index.html"), "utf8"), "<main>X-Lab</main>");
  assert.equal(readFileSync(join(source, "index.html"), "utf8"), "<main>X-Lab</main>");
});
