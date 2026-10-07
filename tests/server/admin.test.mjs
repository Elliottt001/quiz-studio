import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/server/app.mjs";
import { newTestDb, makeQuestionBank } from "./helpers.mjs";
import { hashAdminPassword, registerPlayer } from "../../src/server/auth.mjs";
import { importQuestionBank, startRound, settleDueRounds, voidRound } from "../../src/server/rounds.mjs";
import { scoreRound, submitAnswers } from "../../src/server/answers.mjs";
import { listStandings } from "../../src/server/standings.mjs";

test("admin can review registered players and grant a no-answer staff exception", async () => {
  const fixture = newTestDb();
  const id = registerPlayer(fixture.db, {
    realName: "工作人员", nickname: "STAFF", grade: 2025, team: "operations"
  }, 100).playerId;
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("operator")
  });
  const url = await app.listen(0, "127.0.0.1");
  const post = (path, body, cookie) => fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const publicState = await (await fetch(`${url}/api/state`)).json();
    assert.equal(publicState.registeredCount, 1);
    assert.equal(publicState.submissionCounts[1], 0);
    assert.equal((await fetch(`${url}/api/admin/players`)).status, 401);
    const login = await post("/api/admin/login", { password: "operator" });
    const cookie = login.headers.get("set-cookie");
    const before = await (await fetch(`${url}/api/admin/players`, { headers: { cookie } })).json();
    assert.equal(before.players[0].id, id);
    assert.equal(before.players[0].qualified, false);
    assert.equal((await post(`/api/admin/players/${id}/work-override`, { reason: "现场执行" }, cookie)).status, 200);
    const after = await (await fetch(`${url}/api/admin/players`, { headers: { cookie } })).json();
    assert.equal(after.players[0].qualified, true);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("round invalidation removes its points for everyone and stays in the audit trail", () => {
  const fixture = newTestDb();
  try {
    const db = fixture.db;
    importQuestionBank(db, makeQuestionBank(), "admin", 100);
    const id = registerPlayer(db, {
      realName: "答题者", nickname: "PLAYER", grade: 2024, team: "design"
    }, 100).playerId;
    startRound(db, 1, "admin", 1_000);
    submitAnswers(db, id, 1, { q1: 0 }, "once", 1_100);
    settleDueRounds(db, 301_000, scoreRound);
    assert.equal(listStandings(db)[0].score, 10);
    voidRound(db, 1, "现场内容有误", "admin", 301_100);
    assert.equal(listStandings(db)[0].score, 0);
    assert.equal(db.prepare("SELECT kind FROM audit_events ORDER BY id DESC LIMIT 1").get().kind, "round_voided");
  } finally { fixture.close(); }
});
