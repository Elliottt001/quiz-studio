import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp } from "../../src/server/app.mjs";
import { openDb } from "../../src/server/db.mjs";
import {
  importQuestionBank, startRound, getRoundState, settleDueRounds, publicRound
} from "../../src/server/rounds.mjs";
import { hashAdminPassword } from "../../src/server/auth.mjs";
import { makeQuestionBank, newTestDb } from "./helpers.mjs";

test("agenda time never opens a round; an admin start persists a 300-second deadline", () => {
  const fixture = newTestDb();
  try {
    importQuestionBank(fixture.db, makeQuestionBank(), "admin", 100);
    assert.equal(publicRound(fixture.db, Date.parse("2026-10-11T14:30:00+08:00")).status, "prepared");
    const started = startRound(fixture.db, 1, "admin", 2_000);
    assert.equal(started.deadlineAt, 302_000);
    assert.throws(() => startRound(fixture.db, 1, "admin", 2_001));
    assert.deepEqual(settleDueRounds(fixture.db, 301_999), []);
    assert.deepEqual(settleDueRounds(fixture.db, 302_000), [1]);
    assert.equal(getRoundState(fixture.db, 1).status, "published");
    assert.deepEqual(settleDueRounds(fixture.db, 302_001), []);
  } finally { fixture.close(); }
});

test("restart after a deadline closes the original round once, without a new start", () => {
  const fixture = newTestDb();
  try {
    importQuestionBank(fixture.db, makeQuestionBank(), "admin", 100);
    startRound(fixture.db, 1, "admin", 2_000);
    fixture.db.close();
    const reopened = openDb(fixture.path);
    assert.equal(getRoundState(reopened, 1).deadlineAt, 302_000);
    assert.deepEqual(settleDueRounds(reopened, 302_100), [1]);
    assert.deepEqual(settleDueRounds(reopened, 302_101), []);
    reopened.close();
  } finally {
    rmSync(dirname(fixture.path), { recursive: true, force: true });
  }
});

test("public question payload hides answers and only admin credentials start a round", async () => {
  const fixture = newTestDb();
  let now = 10_000;
  const app = buildApp(fixture.db, () => now, {
    adminPasswordHash: hashAdminPassword("operator-pass")
  });
  const url = await app.listen(0, "127.0.0.1");
  const post = (path, body, cookie) => fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await post("/api/admin/rounds/1/start", {})).status, 401);
    const login = await post("/api/admin/login", { password: "operator-pass" });
    const cookie = login.headers.get("set-cookie");
    assert.equal((await post("/api/admin/questions/import", { questions: makeQuestionBank() }, cookie)).status, 200);
    assert.equal((await post("/api/admin/rounds/1/start", {}, cookie)).status, 200);
    const visible = await (await fetch(`${url}/api/rounds/1`)).json();
    assert.equal(visible.questions.length, 6);
    assert.equal(JSON.stringify(visible).includes("correctOption"), false);
    now += 300_000;
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.rounds[0].status, "published");
  } finally {
    await app.close();
    fixture.close();
  }
});
