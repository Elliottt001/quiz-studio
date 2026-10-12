import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import {
  createGame, getGameForMember, requireGameRole
} from "../../src/platform/games/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("a blank game belongs only to its owner and cannot be confused with another game", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const alice = await createOrganizer(pool, { login: "alice", password: "alice-password-1" });
    const bob = await createOrganizer(pool, { login: "bob", password: "bob-password-2" });
    const game = await createGame(pool, alice.id, { slug: "science-night", title: " Science Night " });
    assert.equal(game.status, "draft");
    assert.equal(game.title, "Science Night");
    assert.equal((await getGameForMember(pool, game.id, alice.id)).id, game.id);
    await assert.rejects(getGameForMember(pool, game.id, bob.id), (e) => e.status === 404);
    await requireGameRole(pool, game.id, alice.id, ["owner"]);
    await assert.rejects(requireGameRole(pool, game.id, alice.id, ["operator"]),
      (e) => e.status === 404);
    await assert.rejects(requireGameRole(pool, game.id, bob.id, ["owner"]),
      (e) => e.status === 404);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM game_members WHERE game_id=$1",
      [game.id])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM game_versions WHERE game_id=$1",
      [game.id])).rows[0].n, 1);
    for (const table of ["players", "rounds", "questions"]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE game_id=$1`,
        [game.id])).rows[0].n, 0);
    }
    await assert.rejects(createGame(pool, bob.id, {
      slug: "science-night", title: "Duplicate"
    }), (e) => e.status === 409);
    await assert.rejects(createGame(pool, bob.id, {
      slug: "../private", title: "Bad"
    }), (e) => e.status === 400);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM games")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT kind FROM audit_events WHERE game_id=$1",
      [game.id])).rows[0].kind, "game_created");
  } finally {
    await close();
  }
});

test("game HTTP list and guessed UUID reads are scoped by organizer session", async () => {
  const { pool, close } = await newPlatformFixture();
  await createOrganizer(pool, { login: "alice", password: "alice-password-1" });
  await createOrganizer(pool, { login: "bob", password: "bob-password-2" });
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST", headers: { origin: "https://quiz.example",
      "x-quiz-action": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const aLogin = await post("/v2/auth/login", { login: "alice", password: "alice-password-1" });
    const bLogin = await post("/v2/auth/login", { login: "bob", password: "bob-password-2" });
    const aliceCookie = aLogin.headers.get("set-cookie");
    const bobCookie = bLogin.headers.get("set-cookie");
    const created = await post("/v2/games", { slug: "science-night", title: "Science Night" }, aliceCookie);
    assert.equal(created.status, 201);
    const game = await created.json();
    assert.equal((await (await fetch(base + "/v2/games", {
      headers: { cookie: aliceCookie }
    })).json()).games.length, 1);
    assert.deepEqual((await (await fetch(base + "/v2/games", {
      headers: { cookie: bobCookie }
    })).json()).games, []);
    assert.equal((await fetch(base + `/v2/games/${game.id}`, {
      headers: { cookie: bobCookie }
    })).status, 404);
    assert.equal((await fetch(base + `/v2/games/${game.id}`, {
      headers: { cookie: aliceCookie }
    })).status, 200);
    assert.equal((await post("/v2/games", { slug: "guest", title: "Guest" })).status, 401);
  } finally {
    await app.close();
    await close();
  }
});
