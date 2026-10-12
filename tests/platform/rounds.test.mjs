import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import {
  createRound, publishGame, startRound, getPublicRound
} from "../../src/platform/quiz/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";

const question = (position = 1) => ({
  position, kind: "choice", prompt: `Q${position}?`, options: ["A", "B"],
  correctOption: 1, points: 7
});

test("games have independent configurable rounds and concurrent start is single-winner", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const alice = await createOrganizer(pool, { login: "alice", password: "alice-password-1" });
    const bob = await createOrganizer(pool, { login: "bob", password: "bob-password-2" });
    const gameA = await createGame(pool, alice.id, { slug: "science-night", title: "Science" });
    const gameB = await createGame(pool, bob.id, { slug: "history-night", title: "History" });
    await assert.rejects(publishGame(pool, gameA.id, alice.id), (e) => e.status === 409);
    const one = await createRound(pool, gameA.id, alice.id, {
      position: 1, title: "Speed quiz", durationMs: 90_000, questions: [question()]
    });
    await createRound(pool, gameB.id, bob.id, {
      position: 1, title: "Long quiz", durationMs: 600_000, questions: [question(), question(2)]
    });
    assert.deepEqual((await getPublicRound(pool, gameA.id, one.id)).questions, []);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM rounds WHERE game_id=$1",
      [gameA.id])).rows[0].n, 1);
    await assert.rejects(startRound(pool, gameA.id, one.id, bob.id, 1000),
      (e) => e.status === 404);
    await publishGame(pool, gameA.id, alice.id);
    await publishGame(pool, gameB.id, bob.id);
    const started = await Promise.allSettled([
      startRound(pool, gameA.id, one.id, alice.id, 1000),
      startRound(pool, gameA.id, one.id, alice.id, 1000)
    ]);
    assert.equal(started.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(started.find((r) => r.status === "fulfilled").value.deadlineAt, 91_000);
    assert.equal((await getPublicRound(pool, gameA.id, one.id)).questions.length, 1);
    assert.equal((await getPublicRound(pool, gameA.id, one.id)).questions[0].correctOption, undefined);
    await assert.rejects(createRound(pool, gameA.id, alice.id, {
      position: 2, title: "Late", durationMs: 90_000, questions: [question()]
    }), (e) => e.status === 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE game_id=$1",
      [gameA.id])).rows[0].n, 4);
  } finally {
    await close();
  }
});

test("round HTTP setup requires membership and never leaks prepared answers", async () => {
  const { pool, close } = await newPlatformFixture();
  const alice = await createOrganizer(pool, { login: "alice", password: "alice-password-1" });
  await createOrganizer(pool, { login: "bob", password: "bob-password-2" });
  const game = await createGame(pool, alice.id, { slug: "science-night", title: "Science" });
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST", headers: { origin: "https://quiz.example", "x-quiz-action": "1",
      "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const a = (await post("/v2/auth/login", { login: "alice", password: "alice-password-1" }))
      .headers.get("set-cookie");
    const b = (await post("/v2/auth/login", { login: "bob", password: "bob-password-2" }))
      .headers.get("set-cookie");
    const created = await post(`/v2/games/${game.id}/rounds`, {
      position: 1, title: "First", durationMs: 30_000, questions: [question()]
    }, a);
    assert.equal(created.status, 201);
    const round = await created.json();
    assert.equal((await post(`/v2/games/${game.id}/publish`, {}, b)).status, 404);
    assert.equal((await post(`/v2/games/${game.id}/rounds/${round.id}/start`, {}, b)).status, 404);
    assert.equal((await fetch(base + `/v2/games/${game.slug}/rounds/${round.id}`)).status, 404);
    assert.equal((await post(`/v2/games/${game.id}/publish`, {}, a)).status, 200);
    const beforeStart = await (await fetch(base + `/v2/games/${game.slug}/rounds/${round.id}`)).json();
    assert.deepEqual(beforeStart.questions, []);
    assert.equal((await post(`/v2/games/${game.id}/rounds/${round.id}/start`, {}, a)).status, 200);
    const active = await (await fetch(base + `/v2/games/${game.slug}/rounds/${round.id}`)).json();
    assert.equal(active.questions.length, 1);
    assert.equal(JSON.stringify(active).includes("correctOption"), false);
  } finally {
    await app.close();
    await close();
  }
});
