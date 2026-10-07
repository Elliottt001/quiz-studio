import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/server/app.mjs";
import { hashAdminPassword } from "../../src/server/auth.mjs";
import { makeQuestionBank, newTestDb } from "./helpers.mjs";

test("two players complete four admin-started rounds and draw distinct small/grand prizes", async () => {
  const fixture = newTestDb();
  let now = 1_000;
  const app = buildApp(fixture.db, () => now, {
    adminPasswordHash: hashAdminPassword("operator-for-tests")
  });
  const url = await app.listen(0, "127.0.0.1");
  const request = async (path, method = "GET", body, cookie) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json", "x-xlab-action": "1" }),
        ...(cookie ? { cookie } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  };
  try {
    const first = await request("/api/players", "POST", {
      realName: "甲同学", nickname: "STAR", grade: 2025, team: "software",
      password: "first-test-password"
    });
    const second = await request("/api/players", "POST", {
      realName: "乙同学", nickname: "STAR", grade: 2024, team: "hardware",
      password: "second-test-password"
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const login = await request("/api/admin/login", "POST", { password: "operator-for-tests" });
    assert.equal(login.status, 200);
    const admin = login.cookie;
    assert.equal((await request("/api/admin/questions/import", "POST",
      { questions: makeQuestionBank() }, admin)).status, 200);
    assert.equal((await request("/api/admin/prizes", "POST", {
      prizes: [
        { id: "third-1", tier: "third", title: "小奖", position: 1 },
        { id: "grand-1", tier: "grand", title: "大奖", position: 1 }
      ]
    }, admin)).status, 200);
    assert.equal((await request("/api/rounds/1")).body.questions.length, 0);
    for (let round = 1; round <= 4; round++) {
      const start = await request(`/api/admin/rounds/${round}/start`, "POST", {}, admin);
      assert.equal(start.status, 200);
      assert.equal(start.body.deadlineAt - start.body.startedAt, 300_000);
      const publicRound = await request(`/api/rounds/${round}`);
      assert.equal(JSON.stringify(publicRound.body).includes("correctOption"), false);
      if (round === 1) {
        const a = await request("/api/rounds/1/submit", "POST",
          { answers: { q1: 0 }, requestKey: "first-r1" }, first.cookie);
        const b = await request("/api/rounds/1/submit", "POST",
          { answers: { q1: 1 }, requestKey: "second-r1" }, second.cookie);
        assert.equal(a.status, 201);
        assert.equal(b.status, 201);
      }
      if (round === 4) {
        const a = await request("/api/rounds/4/submit", "POST",
          { answers: { q30: "我想继续探索和协作" }, requestKey: "first-r4" }, first.cookie);
        assert.equal(a.status, 201);
      }
      now = start.body.deadlineAt;
      const state = await request("/api/state");
      assert.equal(state.body.rounds[round - 1].status, "published");
      const result = await request(`/api/rounds/${round}/my`, "GET", undefined, first.cookie);
      assert.equal(round === 1 || round === 4 ? result.body.score?.points : result.body.score, round === 1 || round === 4 ? 10 : null);
    }
    const standings = await request("/api/standings");
    assert.equal(standings.body.players.find((p) => p.id === first.body.id).score, 20);
    assert.equal(standings.body.players.find((p) => p.id === second.body.id).score, 0);
    const freeze = await request("/api/admin/pool/freeze", "POST", {}, admin);
    assert.equal(freeze.status, 200);
    assert.deepEqual(freeze.body.entries.map((entry) => entry.balls).sort((a, b) => a - b), [10, 12]);
    const third = await request("/api/admin/prizes/third-1/draw", "POST", { requestKey: "draw-small" }, admin);
    const grand = await request("/api/admin/prizes/grand-1/draw", "POST", { requestKey: "draw-grand" }, admin);
    assert.equal(third.status, 200);
    assert.equal(grand.status, 200);
    assert.notEqual(third.body.playerId, grand.body.playerId);
    assert.equal((await request("/api/draws")).body.draws.length, 2);
    const exported = await request("/api/admin/export", "GET", undefined, admin);
    assert.equal(exported.body.draws.length, 2);
    assert.equal(exported.body.frozen.length, 1);
    const publicFourth = await request("/api/rounds/4");
    assert.equal(JSON.stringify(publicFourth.body).includes("我想继续探索和协作"), false);
  } finally {
    await app.close();
    fixture.close();
  }
});
