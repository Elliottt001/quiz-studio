import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/server/db.mjs";
import { backupDatabase } from "../../src/server/backup.mjs";
import { inspectBackup } from "../../scripts/backup-check.mjs";
import { runLoadTest } from "../../scripts/load-test.mjs";

test("backup inspector reports persisted counts and integrity without mutating the snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xlab-inspect-"));
  const source = openDb(join(directory, "source.sqlite"));
  const target = join(directory, "snapshot.sqlite");
  try {
    source.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at)
      VALUES('p1','甲','ONE',2025,'software',100)`).run();
    await backupDatabase(source, target);
    const report = inspectBackup(target);
    assert.deepEqual(report, {
      integrity: "ok", players: 1, submissions: 0,
      scores: 0, freezeHash: null, draws: 0, deadlines: [null, null, null, null]
    });
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("load harness reports accepted receipts, no duplicate scores and cutoff rejection", async () => {
  const report = await runLoadTest({ clients: 25, submitters: 20 });
  assert.equal(report.registered, 25);
  assert.equal(report.accepted, 20);
  assert.equal(report.uniqueScores, 20);
  assert.equal(report.duplicateScores, 0);
  assert.equal(report.lateRejected, true);
  assert.ok(report.p95Ms >= 0);
  assert.ok(report.burstElapsedMs >= 0);
  assert.ok(report.burstElapsedMs < 1000, "the reported load finished inside a real one-second window");
});
