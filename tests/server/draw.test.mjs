import { test } from "node:test";
import assert from "node:assert/strict";
import { newTestDb } from "./helpers.mjs";
import { freezePool, markAttendance } from "../../src/server/standings.mjs";
import { configurePrizes, drawWinner, getDraw, refusePrize, listDraws } from "../../src/server/draw.mjs";

function seededPool(scores, prizes = [
  { id: "third-1", tier: "third", title: "三等奖", position: 1 },
  { id: "second-1", tier: "second", title: "二等奖", position: 1 },
  { id: "grand-1", tier: "grand", title: "大奖", position: 1 }
]) {
  const fixture = newTestDb();
  fixture.db.prepare("UPDATE rounds SET status='voided'").run();
  fixture.db.prepare("UPDATE rounds SET status='published' WHERE id=1").run();
  const ids = [];
  for (const [index, score] of scores.entries()) {
    const id = `player-${String(index).padStart(2, "0")}`;
    fixture.db.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at)
      VALUES(?,?,?,?,?,?)`).run(id, `同学${index}`, `PLAYER${index}`, 2025, "software", 100);
    fixture.db.prepare("INSERT INTO eligibility(player_id,updated_at) VALUES(?,?)").run(id, 100);
    ids.push(id);
    markAttendance(fixture.db, id, "admin", 200);
    fixture.db.prepare(`INSERT INTO submissions
      (id,player_id,round_id,request_key,answers_json,revision,submitted_at)
      VALUES(?,?,?,?,?,?,?)`).run(`s${index}`, id, 1, `r${index}`, "{}", 1, 201);
    fixture.db.prepare(`INSERT INTO round_scores(player_id,round_id,points,answers_json)
      VALUES(?,?,?,?)`).run(id, 1, score, "{}");
  }
  configurePrizes(fixture.db, prizes, "admin", 250);
  freezePool(fixture.db, "admin", 300);
  return { ...fixture, ids };
}

test("small prizes draw first, double-click returns the same saved ball, and refusal never restores a winner", () => {
  const fixture = seededPool([0, 10, 20]);
  try {
    assert.throws(() => drawWinner(fixture.db, "grand-1", "early", () => 0), /顺序/);
    const first = drawWinner(fixture.db, "third-1", "click-1", () => 0);
    assert.equal(first.selectedBallId, `${first.playerId}:1`);
    assert.equal(getDraw(fixture.db, first.id).playerId, first.playerId);
    assert.deepEqual(drawWinner(fixture.db, "third-1", "click-1", () => 10), first);
    refusePrize(fixture.db, first.id, "本人放弃", "admin", 400);
    const replacement = drawWinner(fixture.db, "third-1", "click-2", () => 0);
    assert.notEqual(replacement.playerId, first.playerId);
    const second = drawWinner(fixture.db, "second-1", "click-3", () => 0);
    assert.notEqual(second.playerId, first.playerId);
    assert.equal(new Set(listDraws(fixture.db).map((draw) => draw.playerId)).size, 3);
  } finally { fixture.close(); }
});

test("every prize tier uses the same fixed ball weights among those still eligible", () => {
  for (const tier of ["third", "second", "grand"]) {
    const hits = { 0: 0, 10: 0 };
    const ballIds = new Set();
    for (let index = 0; index < 21; index++) {
      const fixture = seededPool([0, 10], [
        { id: `${tier}-only`, tier, title: tier, position: 1 }
      ]);
      try {
        const winner = drawWinner(fixture.db, `${tier}-only`, `try-${index}`, () => index);
        const score = fixture.db.prepare("SELECT points FROM round_scores WHERE player_id=?")
          .get(winner.playerId).points;
        hits[score]++;
        ballIds.add(winner.selectedBallId);
      } finally { fixture.close(); }
    }
    assert.deepEqual(hits, { 0: 10, 10: 11 });
    assert.equal(ballIds.size, 21);
  }
});

test("pool cannot freeze without a prize list or when prizes outnumber eligible players", () => {
  const fixture = newTestDb();
  try {
    const db = fixture.db;
    db.prepare("UPDATE rounds SET status='voided'").run();
    db.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at)
      VALUES('one','甲','ONE',2025,'software',100)`).run();
    db.prepare("INSERT INTO eligibility(player_id,checked_in,eligible_override,updated_at) VALUES('one',1,1,100)")
      .run();
    assert.throws(() => freezePool(db, "admin", 200), /奖品/);
    configurePrizes(db, [
      { id: "third-1", tier: "third", title: "三等奖一", position: 1 },
      { id: "third-2", tier: "third", title: "三等奖二", position: 2 }
    ], "admin", 201);
    assert.throws(() => freezePool(db, "admin", 202), /人数/);
    configurePrizes(db, [{ id: "grand-1", tier: "grand", title: "大奖", position: 1 }], "admin", 203);
    assert.equal(freezePool(db, "admin", 204).entries.length, 1);
  } finally { fixture.close(); }
});
