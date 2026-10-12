import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";

test("HTTP boundary rejects untrusted, malformed, or oversized changes before the handler", async () => {
  const { pool, close } = await newPlatformFixture();
  let calls = 0;
  const app = buildPlatformApp({ pool, clock: () => 1234, publicOrigin: "https://quiz.example" });
  app.route("POST", /^\/v2\/echo$/, ({ body, receivedAt }) => {
    calls++;
    return { body: { body, receivedAt } };
  });
  const base = await app.listen(0);
  const post = (body, headers = {}) => fetch(base + "/v2/echo", {
    method: "POST", headers: { origin: "https://quiz.example", "content-type": "application/json",
      "x-quiz-action": "1", ...headers },
    body
  });
  try {
    assert.equal((await post('{"ok":true}', { origin: "https://wrong.example" })).status, 403);
    assert.equal((await post('{"ok":true}', { origin: "" })).status, 403);
    assert.equal((await post('{"ok":true}', { "x-quiz-action": "0" })).status, 403);
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("null")).status, 400);
    assert.equal((await post("[]")).status, 400);
    assert.equal((await post(JSON.stringify({ text: "x".repeat(65_536) }))).status, 413);
    assert.equal(calls, 0);
    const accepted = await post('{"ok":true}');
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { body: { ok: true }, receivedAt: 1234 });
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await close();
  }
});

test("a public listener needs an explicit trusted TLS proxy, not just an origin string", async () => {
  const { pool, close } = await newPlatformFixture();
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  try {
    await assert.rejects(app.listen(0, "0.0.0.0"), /可信 HTTPS 代理/);
  } finally {
    await app.close().catch(() => {});
    await close();
  }
});

test("only the game owner may send large round edits; all other bodies stay at 64 KiB", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, {
    login: "owner", password: "owner-password-1"
  });
  const operator = await createOrganizer(pool, {
    login: "operator", password: "operator-password-1"
  });
  const game = await createGame(pool, owner.id, {
    slug: "large-editor", title: "Large editor"
  });
  await pool.query(`INSERT INTO game_members(game_id,organizer_id,role)
    VALUES($1,$2,'operator')`, [game.id, operator.id]);
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, text, cookie) => fetch(base + path, {
    method: "POST",
    headers: {
      origin: "https://quiz.example",
      "content-type": "application/json",
      "x-quiz-action": "1",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify({ title: text })
  });
  try {
    const ownerLogin = await post("/v2/auth/login", "ignored");
    assert.equal(ownerLogin.status, 401);
    const login = async (name, password) => {
      const response = await fetch(base + "/v2/auth/login", {
        method: "POST", headers: { origin: "https://quiz.example",
          "content-type": "application/json", "x-quiz-action": "1" },
        body: JSON.stringify({ login: name, password })
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie");
    };
    const ownerCookie = await login("owner", "owner-password-1");
    const operatorCookie = await login("operator", "operator-password-1");
    const roundPath = `/v2/games/${game.id}/rounds`;
    assert.equal((await post(roundPath, "x".repeat(70_000), ownerCookie)).status, 400);
    assert.equal((await post(roundPath, "x".repeat(70_000))).status, 401);
    assert.equal((await post(roundPath, "x".repeat(70_000), operatorCookie)).status, 404);
    assert.equal((await post("/v2/auth/login", "x".repeat(70_000), ownerCookie)).status, 413);
    assert.equal((await post(roundPath, "x".repeat(1_048_576), ownerCookie)).status, 413);
  } finally {
    await app.close();
    await close();
  }
});
