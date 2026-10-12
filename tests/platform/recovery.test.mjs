import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { registerPlayer, requirePlayerForGame, loginPlayer } from "../../src/platform/players/repository.mjs";
import { issueRecovery, redeemRecovery } from "../../src/platform/players/recovery.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("one-time recovery is hashed, scoped, expires, and revokes only the recovered player's sessions", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const gameA = await createGame(pool, owner.id, { slug: "recovery-a", title: "A" });
    const gameB = await createGame(pool, owner.id, { slug: "recovery-b", title: "B" });
    await pool.query("UPDATE games SET status='published',published_version=1 WHERE id=ANY($1::uuid[])",
      [[gameA.id, gameB.id]]);
    const a = await registerPlayer(pool, gameA.id, {
      displayName: "A", password: "old-password-1"
    });
    const b = await registerPlayer(pool, gameB.id, {
      displayName: "B", password: "old-password-2"
    });
    const now = Date.now();
    const cookieA = { headers: { cookie: `game_session_${gameA.slug}=${a.sessionToken}` } };
    const cookieB = { headers: { cookie: `game_session_${gameB.slug}=${b.sessionToken}` } };
    const code = await issueRecovery(pool, gameA.id, a.playerId, owner.id, now);
    assert.equal(typeof code, "string");
    assert.ok(code.length >= 32);
    const stored = (await pool.query(`SELECT code_hash FROM recovery_codes
      WHERE game_id=$1`, [gameA.id])).rows[0].code_hash;
    assert.equal(stored.includes(code), false);
    await assert.rejects(redeemRecovery(pool, gameB.id, code, "new-password-1", now + 1),
      (error) => error.status === 409);
    const restored = await redeemRecovery(pool, gameA.id, code, "new-password-1", now + 1);
    assert.equal(restored.playerId, a.playerId);
    assert.equal(restored.loginCode, a.loginCode);
    assert.equal(await requirePlayerForGame(pool, {
      headers: { cookie: `game_session_${gameA.slug}=${restored.sessionToken}` }
    }, gameA.id), a.playerId);
    await assert.rejects(requirePlayerForGame(pool, cookieA, gameA.id),
      (error) => error.status === 401);
    assert.equal(await requirePlayerForGame(pool, cookieB, gameB.id), b.playerId);
    await assert.rejects(loginPlayer(pool, gameA.id, a.loginCode, "old-password-1"),
      (error) => error.status === 401);
    assert.equal((await loginPlayer(pool, gameA.id, a.loginCode, "new-password-1")).playerId,
      a.playerId);
    await assert.rejects(redeemRecovery(pool, gameA.id, code, "again-password-1", now + 2),
      (error) => error.status === 409);
    const expired = await issueRecovery(pool, gameA.id, a.playerId, owner.id, now + 1000);
    await assert.rejects(redeemRecovery(pool, gameA.id, expired, "later-password-1",
      now + 1000 + 600_000), (error) => error.status === 409);
    await assert.rejects(issueRecovery(pool, gameA.id, b.playerId, owner.id, now + 1001),
      (error) => error.status === 404);
  } finally {
    await close();
  }
});

test("recovery API requires a game operator and exchanges code for a scoped player cookie", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const game = await createGame(pool, owner.id, { slug: "recover-api", title: "API" });
  await pool.query("UPDATE games SET status='published',published_version=1 WHERE id=$1", [game.id]);
  const player = await registerPlayer(pool, game.id, {
    displayName: "Player", password: "player-password-1"
  });
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST", headers: { origin: "https://quiz.example",
      "x-quiz-action": "1", "content-type": "application/json",
      ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await post(`/v2/games/${game.id}/players/${player.playerId}/recovery`,
      {})).status, 401);
    const login = await post("/v2/auth/login", {
      login: owner.login, password: "owner-password-1"
    });
    const issued = await post(`/v2/games/${game.id}/players/${player.playerId}/recovery`,
      {}, login.headers.get("set-cookie"));
    assert.equal(issued.status, 200);
    const { code } = await issued.json();
    assert.equal((await fetch(base + `/v2/games/${game.slug}/state`)).status, 200);
    const restored = await post(`/v2/games/${game.slug}/recover`, {
      code, password: "fresh-password-1"
    });
    assert.equal(restored.status, 200);
    assert.match(restored.headers.get("set-cookie"), /game_session_recover-api=.*HttpOnly/);
  } finally {
    await app.close();
    await close();
  }
});
