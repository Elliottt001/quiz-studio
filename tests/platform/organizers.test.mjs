import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { hashPassword } from "../../src/platform/auth/password.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("organizer sessions are distinct, revocable, and only platform admin provisions organizers", async () => {
  const { pool, close } = await newPlatformFixture();
  await createOrganizer(pool, { login: "owner", password: "long-password-1", platformAdmin: true });
  await createOrganizer(pool, { login: "operator", password: "long-password-2" });
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST",
    headers: { origin: "https://quiz.example", "content-type": "application/json",
      "x-quiz-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await post("/v2/auth/login", { login: "owner", password: "bad-password" })).status, 401);
    assert.equal((await post("/v2/organizers", {
      login: "guest", password: "long-password-3"
    }, "player_session=not-an-admin")).status, 401);
    const login = await post("/v2/auth/login", { login: "owner", password: "long-password-1" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /organizer_session=.*HttpOnly.*SameSite=Strict.*Secure/);
    assert.equal((await post("/v2/organizers", {
      login: "new-organizer", password: "long-password-3"
    }, cookie)).status, 201);
    const audit = (await pool.query(`SELECT actor_id,kind,target_id,details_json
      FROM platform_audit_events ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(audit.kind, "organizer_created");
    assert.equal(audit.details_json.login, "new-organizer");
    assert.equal(audit.details_json.password, undefined);
    assert.equal(audit.actor_id, (await pool.query("SELECT id FROM organizers WHERE login='owner'")).rows[0].id);
    const ordinary = await post("/v2/auth/login", {
      login: "operator", password: "long-password-2"
    });
    assert.equal((await post("/v2/organizers", {
      login: "forbidden", password: "long-password-4"
    }, ordinary.headers.get("set-cookie"))).status, 403);
    assert.equal((await post("/v2/auth/logout", {}, cookie)).status, 200);
    assert.equal((await post("/v2/organizers", {
      login: "after-logout", password: "long-password-5"
    }, cookie)).status, 401);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organizers")).rows[0].n, 3);
  } finally {
    await app.close();
    await close();
  }
});

test("password hashing does not block the event loop", async () => {
  const hashing = hashPassword("long-password-for-event-loop");
  let ticked = false;
  setImmediate(() => { ticked = true; });
  await hashing;
  assert.equal(ticked, true);
});

test("read-only session status avoids an expected 401 while leaving management routes protected", async () => {
  const { pool, close } = await newPlatformFixture();
  await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const app = buildPlatformApp({ pool, autoSettle: false });
  const base = await app.listen(0);
  try {
    const unknown = await fetch(base + "/v2/auth/status");
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { authenticated: false });
    assert.equal((await fetch(base + "/v2/games")).status, 401);
    const login = await fetch(base + "/v2/auth/login", {
      method: "POST", headers: { "x-quiz-action": "1", "content-type": "application/json" },
      body: JSON.stringify({ login: "owner", password: "owner-password-1" })
    });
    assert.equal(login.status, 200);
    const valid = await fetch(base + "/v2/auth/status", {
      headers: { cookie: login.headers.get("set-cookie") }
    });
    assert.deepEqual(await valid.json(), { authenticated: true });
  } finally {
    await app.close();
    await close();
  }
});
