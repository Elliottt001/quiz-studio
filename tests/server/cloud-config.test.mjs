import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStorage } from "../../src/server/config.mjs";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/server/db.mjs";
import { buildApp } from "../../src/server/app.mjs";

test("cloud storage path uses the persistent mount and not the source checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "xlab-cloud-"));
  try {
    const storage = resolveStorage({ DATA_DIR: join(base, "mounted") });
    assert.equal(storage.game, join(base, "mounted", "game.sqlite"));
    assert.equal(storage.backup, join(base, "mounted", "backup-latest.sqlite"));
    assert.equal(statSync(storage.directory).mode & 0o077, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("older SQLite player data survives the additive password migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-legacy-"));
  const path = join(directory, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE players(
      id TEXT PRIMARY KEY, real_name TEXT, nickname TEXT, grade INTEGER, team TEXT, created_at INTEGER
    )`);
    legacy.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at)
      VALUES('old-user','老玩家','RETURN',2021,'software',100)`).run();
    legacy.close();
    const upgraded = openDb(path);
    assert.equal(upgraded.prepare("SELECT real_name FROM players WHERE id='old-user'").get().real_name, "老玩家");
    assert.equal(upgraded.prepare("SELECT password_hash FROM players WHERE id='old-user'").get().password_hash, null);
    const firstCode = upgraded.prepare("SELECT login_code FROM players WHERE id='old-user'").get().login_code;
    assert.match(firstCode, /^[A-F0-9]{16}$/);
    upgraded.close();
    const reopened = openDb(path);
    assert.equal(reopened.prepare("SELECT login_code FROM players WHERE id='old-user'").get().login_code, firstCode);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("health check stops reporting success when the database is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-health-"));
  const db = openDb(join(directory, "game.sqlite"));
  const app = buildApp(db);
  const base = await app.listen(0, "127.0.0.1");
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    db.close();
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
