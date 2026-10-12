import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newTestDb } from "../server/helpers.mjs";
import { inspectBackup } from "../../scripts/backup-check.mjs";
import { archiveLegacy } from "../../scripts/archive-legacy.mjs";

test("archives a consistent private SQLite snapshot outside the repository", async () => {
  const fixture = newTestDb();
  const parent = mkdtempSync(join(tmpdir(), "quiz-archive-test-"));
  const archiveDir = join(parent, "sealed");
  try {
    fixture.db.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at)
      VALUES('player-1','测试姓名','PLAY',2025,'software',100)`).run();
    const originalHash = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
    const result = await archiveLegacy({ source: fixture.path, archiveDir });
    assert.equal(inspectBackup(result.snapshot).players, 1);
    assert.equal(result.counts.players, 1);
    assert.equal(result.sha256,
      createHash("sha256").update(readFileSync(result.snapshot)).digest("hex"));
    assert.equal(JSON.parse(readFileSync(result.manifest, "utf8")).sha256, result.sha256);
    assert.equal(statSync(result.snapshot).mode & 0o077, 0);
    assert.equal(statSync(result.manifest).mode & 0o077, 0);
    assert.equal(statSync(archiveDir).mode & 0o077, 0);
    assert.equal(createHash("sha256").update(readFileSync(fixture.path)).digest("hex"), originalHash);
    await assert.rejects(archiveLegacy({ source: fixture.path, archiveDir }), /已存在/);
    await assert.rejects(
      archiveLegacy({ source: fixture.path, archiveDir: resolve("data/forbidden-archive") }),
      /仓库外/
    );
  } finally {
    fixture.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
