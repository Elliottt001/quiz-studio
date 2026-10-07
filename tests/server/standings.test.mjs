import { test } from "node:test";
import assert from "node:assert/strict";
import { newTestDb, makeQuestionBank } from "./helpers.mjs";
import { registerPlayer } from "../../src/server/auth.mjs";
import { importQuestionBank, startRound, settleDueRounds } from "../../src/server/rounds.mjs";
import { submitAnswers, scoreRound } from "../../src/server/answers.mjs";
import {
  addBonus, voidQuestion, ticketCount, listStandings, markAttendance, excludePlayer, freezePool
} from "../../src/server/standings.mjs";

const person = (name) => ({
  realName: name, nickname: name, grade: 2025, team: "software"
});
const addPrize = (db) => db.prepare(
  "INSERT INTO prizes(id,tier,title,position) VALUES('grand-1','grand','大奖',1)"
).run();

test("every additional ten points adds one ball and zero points still has ten", () => {
  for (const [score, balls] of [[0, 10], [10, 11], [100, 20], [200, 30], [320, 42]]) {
    assert.equal(ticketCount(score), balls);
  }
  for (const score of [-10, 5, 330]) assert.throws(() => ticketCount(score));
});

test("bonus caps at 20 and standings only include published quiz scores", () => {
  const fixture = newTestDb();
  try {
    const a = registerPlayer(fixture.db, person("甲"), 100).playerId;
    const b = registerPlayer(fixture.db, person("乙"), 100).playerId;
    fixture.db.prepare("INSERT INTO round_scores(player_id,round_id,points,answers_json) VALUES(?,?,?,?)")
      .run(a, 1, 100, "{}");
    assert.equal(listStandings(fixture.db).find((p) => p.id === a).score, 0);
    fixture.db.prepare("UPDATE rounds SET status='published' WHERE id=1").run();
    addBonus(fixture.db, b, "speaking", 10, "第一段分享", "admin", 200);
    addBonus(fixture.db, b, "work", 10, "会场任务", "admin", 201);
    assert.throws(() => addBonus(fixture.db, b, "speaking", 10, "第二段分享", "admin", 202), /20/);
    const standings = listStandings(fixture.db);
    assert.equal(standings.find((p) => p.id === a).score, 100);
    assert.equal(standings.find((p) => p.id === b).score, 20);
    assert.equal(standings.find((p) => p.id === a).rank, 1);
  } finally { fixture.close(); }
});

test("wrong question is zeroed for everyone and frozen pool ignores excluded and unsubmitted accounts", () => {
  const fixture = newTestDb();
  try {
    const db = fixture.db;
    importQuestionBank(db, makeQuestionBank(), "admin", 100);
    const a = registerPlayer(db, person("甲"), 100).playerId;
    const b = registerPlayer(db, person("乙"), 100).playerId;
    const c = registerPlayer(db, person("丙"), 100).playerId;
    startRound(db, 1, "admin", 1_000);
    submitAnswers(db, a, 1, { q1: 0, q2: 0 }, "a", 1_100);
    submitAnswers(db, b, 1, { q1: 0 }, "b", 1_100);
    settleDueRounds(db, 301_000, scoreRound);
    db.prepare("UPDATE rounds SET status='voided' WHERE id IN (2,3,4)").run();
    for (const id of [a, b, c]) markAttendance(db, id, "admin", 302_000);
    excludePlayer(db, b, "审题人员", "admin", 302_001);
    voidQuestion(db, "q1", "题意不清", "admin", 302_002);
    assert.equal(listStandings(db).find((p) => p.id === a).score, 10);
    assert.equal(listStandings(db).find((p) => p.id === b).score, 0);
    addPrize(db);
    const frozen = freezePool(db, "admin", 303_000);
    assert.deepEqual(frozen.entries.map((p) => [p.playerId, p.balls]), [[a, 11]]);
    assert.throws(() => addBonus(db, a, "work", 10, "迟报", "admin", 303_001), /冻结/);
  } finally { fixture.close(); }
});

test("all-invalid quiz gives each qualified person one equal ball", () => {
  const fixture = newTestDb();
  try {
    const a = registerPlayer(fixture.db, person("甲"), 100).playerId;
    const b = registerPlayer(fixture.db, person("乙"), 100).playerId;
    fixture.db.prepare("UPDATE rounds SET status='voided'").run();
    for (const id of [a, b]) {
      markAttendance(fixture.db, id, "admin", 200);
      fixture.db.prepare("UPDATE eligibility SET eligible_override=1 WHERE player_id=?").run(id);
    }
    addPrize(fixture.db);
    const frozen = freezePool(fixture.db, "admin", 300);
    assert.deepEqual(frozen.entries.map((p) => p.balls), [1, 1]);
  } finally { fixture.close(); }
});

test("voiding every round activates the equal-ball fallback even if old scores remain stored", () => {
  const fixture = newTestDb();
  try {
    const db = fixture.db;
    importQuestionBank(db, makeQuestionBank(), "admin", 100);
    const id = registerPlayer(db, person("甲"), 100).playerId;
    startRound(db, 1, "admin", 1_000);
    submitAnswers(db, id, 1, { q1: 0 }, "answer", 1_100);
    settleDueRounds(db, 301_000, scoreRound);
    db.prepare("UPDATE rounds SET status='voided'").run();
    markAttendance(db, id, "admin", 302_000);
    addPrize(db);
    assert.equal(freezePool(db, "admin", 303_000).entries[0].balls, 1);
  } finally { fixture.close(); }
});

test("a submitted player joins the provisional pool without an advance check-in", () => {
  const fixture = newTestDb();
  try {
    const db = fixture.db;
    const id = registerPlayer(db, person("未签到玩家"), 100).playerId;
    db.prepare("UPDATE rounds SET status='voided'").run();
    db.prepare(`INSERT INTO submissions(id,player_id,round_id,request_key,answers_json,revision,submitted_at)
      VALUES('submitted',?,1,'key','{}',1,200)`).run(id);
    addPrize(db);
    assert.deepEqual(freezePool(db, "admin", 300).entries.map((entry) => entry.playerId), [id]);
  } finally { fixture.close(); }
});
