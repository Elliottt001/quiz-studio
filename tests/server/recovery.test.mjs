import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/server/db.mjs";
import { buildApp } from "../../src/server/app.mjs";
import { backupDatabase } from "../../src/server/backup.mjs";
import { importQuestionBank, startRound, getRoundState } from "../../src/server/rounds.mjs";
import { configurePrizes, drawWinner, getDraw } from "../../src/server/draw.mjs";
import { freezePool } from "../../src/server/standings.mjs";
import { newTestDb, makeQuestionBank } from "./helpers.mjs";

test("a consistent backup restores the exact deadline and saved winning ball", async () => {
  const fixture = newTestDb();
  const directory = mkdtempSync(join(tmpdir(), "xlab-backup-"));
  const target = join(directory, "latest.sqlite");
  try {
    const db = fixture.db;
    importQuestionBank(db, makeQuestionBank(), "admin", 100);
    startRound(db, 1, "admin", 2_000);
    db.prepare("UPDATE rounds SET status='voided'").run();
    for (const [index, score] of [0, 10].entries()) {
      const id = `player-${index}`;
      db.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at)
        VALUES(?,?,?,?,?,100)`).run(id, `同学${index}`, `PLAYER${index}`, 2025, "software");
      db.prepare("INSERT INTO eligibility(player_id,checked_in,eligible_override) VALUES(?,1,1)").run(id);
      db.prepare("UPDATE rounds SET status='published' WHERE id=1").run();
      db.prepare(`INSERT INTO round_scores(player_id,round_id,points,answers_json)
        VALUES(?,1,?,'{}')`).run(id, score);
    }
    configurePrizes(db, [{ id: "grand-1", tier: "grand", title: "大奖", position: 1 }], "admin", 3_000);
    const frozen = freezePool(db, "admin", 3_100);
    const draw = drawWinner(db, "grand-1", "one", () => 0, 3_200);
    await backupDatabase(db, target);
    assert.equal(statSync(target).mode & 0o077, 0, "the backup must not be readable by other local accounts");
    const restored = openDb(target);
    try {
      assert.equal(getRoundState(restored, 1).deadlineAt, 302_000);
      assert.equal(getDraw(restored, draw.id).selectedBallId, draw.selectedBallId);
      assert.equal(restored.prepare("SELECT hash FROM freeze_snapshots LIMIT 1").get().hash, frozen.hash);
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { restored.close(); }
  } finally {
    fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new game database is private to the current local account", () => {
  const fixture = newTestDb();
  try {
    assert.equal(statSync(fixture.path).mode & 0o077, 0);
  } finally { fixture.close(); }
});

test("non-loopback listening refuses to send player data without TLS and admin credentials", async () => {
  const fixture = newTestDb();
  try {
    const app = buildApp(fixture.db);
    await assert.rejects(() => app.listen(0, "0.0.0.0"), /HTTPS|TLS/);
    await app.close().catch(() => {});
  } finally { fixture.close(); }
});
