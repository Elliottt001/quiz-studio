import { test } from "node:test";
import assert from "node:assert/strict";
import { newTestDb, makeQuestionBank } from "./helpers.mjs";
import { registerPlayer } from "../../src/server/auth.mjs";
import { importQuestionBank, startRound, settleDueRounds } from "../../src/server/rounds.mjs";
import { saveDraft, submitAnswers, reflectionPoints, scoreRound } from "../../src/server/answers.mjs";
import { buildApp } from "../../src/server/app.mjs";

function readyRound(db, id = 1) {
  importQuestionBank(db, makeQuestionBank(), "admin", 100);
  for (let round = 1; round < id; round++) {
    startRound(db, round, "admin", 1_000 + round * 400_000);
    settleDueRounds(db, 301_000 + round * 400_000, scoreRound);
  }
  startRound(db, id, "admin", 2_000_000);
}

test("an unsubmitted draft earns no points or qualification", () => {
  const fixture = newTestDb();
  try {
    readyRound(fixture.db);
    const player = registerPlayer(fixture.db, {
      realName: "甲", nickname: "PLAYER", grade: 2025, team: "software"
    }, 100);
    saveDraft(fixture.db, player.playerId, 1, { q1: 0 }, 2_000_100);
    assert.deepEqual(settleDueRounds(fixture.db, 2_300_000, scoreRound), [1]);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM round_scores").get().n, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 0);
  } finally { fixture.close(); }
});

test("last confirmed revision determines points and accepted retries retain the original receipt", () => {
  const fixture = newTestDb();
  try {
    readyRound(fixture.db);
    const { playerId } = registerPlayer(fixture.db, {
      realName: "乙", nickname: "玩家", grade: 2024, team: "hardware"
    }, 100);
    submitAnswers(fixture.db, playerId, 1, { q1: 1 }, "first", 2_000_100);
    const accepted = submitAnswers(fixture.db, playerId, 1, { q1: 0, q2: 0 }, "second", 2_299_999);
    assert.deepEqual(
      submitAnswers(fixture.db, playerId, 1, { q1: 0, q2: 0 }, "second", 2_300_000), accepted
    );
    assert.throws(
      () => submitAnswers(fixture.db, playerId, 1, { q1: 0 }, "late", 2_300_000),
      /本轮已截止/
    );
    settleDueRounds(fixture.db, 2_300_000, scoreRound);
    assert.equal(
      fixture.db.prepare("SELECT points FROM round_scores WHERE player_id=?").get(playerId).points,
      20
    );
    assert.deepEqual(settleDueRounds(fixture.db, 2_300_001, scoreRound), []);
  } finally { fixture.close(); }
});

test("reflection is a deterministic 5–120 character gift question", () => {
  for (const [length, points] of [[4, 0], [5, 10], [120, 10], [121, 0]]) {
    assert.equal(reflectionPoints("感".repeat(length)), points);
  }
  assert.equal(reflectionPoints("  我想继续参与  "), 10);
  assert.equal(reflectionPoints(" \n  "), 0);
});

test("round four awards reflection points without publishing its answer", () => {
  const fixture = newTestDb();
  try {
    readyRound(fixture.db, 4);
    const { playerId } = registerPlayer(fixture.db, {
      realName: "丙", nickname: "无限玩家", grade: 2019, team: "design"
    }, 100);
    submitAnswers(fixture.db, playerId, 4, { q30: "听完分享我想继续参与" }, "reflection", 2_000_100);
    settleDueRounds(fixture.db, 2_300_000, scoreRound);
    assert.equal(
      fixture.db.prepare("SELECT points FROM round_scores WHERE player_id=? AND round_id=4").get(playerId).points,
      10
    );
  } finally { fixture.close(); }
});

test("after refresh, latest confirmed answers are returned even when an older draft exists", async () => {
  const fixture = newTestDb();
  let now = 2_000_100;
  const { db } = fixture;
  readyRound(db);
  const player = registerPlayer(db, {
    realName: "刷新玩家", nickname: "REFRESH", grade: 2025, team: "software"
  }, 100);
  saveDraft(db, player.playerId, 1, { q1: 1 }, now);
  now += 10;
  submitAnswers(db, player.playerId, 1, { q1: 0 }, "accepted", now);
  const app = buildApp(db, () => now);
  const url = await app.listen(0, "127.0.0.1");
  try {
    const mine = await fetch(`${url}/api/rounds/1/my`, {
      headers: { cookie: `player_session=${player.sessionToken}` }
    });
    assert.equal(mine.status, 200);
    const state = await mine.json();
    assert.deepEqual(state.draft.answers, { q1: 1 });
    assert.deepEqual(state.submission.answers, { q1: 0 });
    assert.equal(state.submission.submittedAt, now);
  } finally {
    await app.close();
    fixture.close();
  }
});
