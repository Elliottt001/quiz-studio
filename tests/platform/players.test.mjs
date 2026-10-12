import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { registerPlayer, requirePlayerForGame } from "../../src/platform/players/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";

async function joinableGames(pool) {
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const gameA = await createGame(pool, owner.id, { slug: "science-night", title: "Science" });
  const gameB = await createGame(pool, owner.id, { slug: "history-night", title: "History" });
  await pool.query("UPDATE games SET status='published' WHERE id=ANY($1::uuid[])",
    [[gameA.id, gameB.id]]);
  return { gameA, gameB };
}

test("player identity, password and cookie are isolated per published game", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const { gameA, gameB } = await joinableGames(pool);
    const a = await registerPlayer(pool, gameA.id, {
      displayName: "Player", password: "secure-password-1"
    });
    const b = await registerPlayer(pool, gameB.id, {
      displayName: "Player", password: "secure-password-2"
    });
    assert.notEqual(a.playerId, b.playerId);
    assert.notEqual(a.loginCode, b.loginCode);
    const aCookie = `game_session_${gameA.slug}=${a.sessionToken}`;
    assert.equal(await requirePlayerForGame(pool, { headers: { cookie: aCookie } }, gameA.id),
      a.playerId);
    await assert.rejects(requirePlayerForGame(pool, { headers: { cookie: aCookie } }, gameB.id),
      (e) => e.status === 401);
    await assert.rejects(registerPlayer(pool, gameA.id, {
      displayName: "Invalid", password: "short"
    }), (e) => e.status === 400);
    const row = (await pool.query("SELECT password_hash FROM players WHERE game_id=$1 AND id=$2",
      [gameA.id, a.playerId])).rows[0];
    assert.equal(row.password_hash.includes("secure-password-1"), false);
    await pool.query("UPDATE player_sessions SET expires_at=0 WHERE game_id=$1 AND player_id=$2",
      [gameA.id, a.playerId]);
    await assert.rejects(requirePlayerForGame(pool, { headers: { cookie: aCookie } }, gameA.id),
      (e) => e.status === 401);
  } finally {
    await close();
  }
});

test("two game cookies coexist and a logout only revokes the selected session", async () => {
  const { pool, close } = await newPlatformFixture();
  const { gameA, gameB } = await joinableGames(pool);
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST", headers: { origin: "https://quiz.example", "content-type": "application/json",
      "x-quiz-action": "1", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body)
  });
  try {
    const a = await post(`/v2/games/${gameA.slug}/players`, {
      displayName: "同名", password: "secure-password-1"
    });
    const b = await post(`/v2/games/${gameB.slug}/players`, {
      displayName: "同名", password: "secure-password-2"
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const aCookie = a.headers.get("set-cookie").split(";")[0];
    const bCookie = b.headers.get("set-cookie").split(";")[0];
    assert.match(a.headers.get("set-cookie"), /HttpOnly.*SameSite=Strict.*Secure/);
    const both = `${aCookie}; ${bCookie}`;
    assert.equal((await fetch(base + `/v2/games/${gameA.slug}/me`, {
      headers: { cookie: both }
    })).status, 200);
    assert.equal((await fetch(base + `/v2/games/${gameB.slug}/me`, {
      headers: { cookie: both }
    })).status, 200);
    assert.equal((await fetch(base + `/v2/games/${gameB.slug}/me`, {
      headers: { cookie: aCookie }
    })).status, 401);
    const registration = await a.json();
    const wrong = await post(`/v2/games/${gameA.slug}/login`, {
      loginCode: registration.loginCode, password: "wrong-password"
    });
    assert.equal(wrong.status, 401);
    assert.equal((await post(`/v2/games/${gameA.slug}/logout`, {}, both)).status, 200);
    assert.equal((await fetch(base + `/v2/games/${gameA.slug}/me`, {
      headers: { cookie: both }
    })).status, 401);
    assert.equal((await fetch(base + `/v2/games/${gameB.slug}/me`, {
      headers: { cookie: both }
    })).status, 200);
    const restored = await post(`/v2/games/${gameA.slug}/login`, {
      loginCode: registration.loginCode, password: "secure-password-1"
    });
    assert.equal(restored.status, 200);
    assert.equal((await fetch(base + `/v2/games/${gameA.slug}/me`, {
      headers: { cookie: restored.headers.get("set-cookie") }
    })).status, 200);
  } finally {
    await app.close();
    await close();
  }
});
