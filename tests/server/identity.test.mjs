import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/server/app.mjs";
import {
  validateRegistration,
  registerPlayer,
  resolvePlayer,
  createRecoveryCode,
  redeemRecoveryCode,
  hashAdminPassword
} from "../../src/server/auth.mjs";
import { newTestDb } from "./helpers.mjs";

const identity = { realName: "李同学", nickname: "PLAYER", grade: 2023, team: "software" };

test("same-looking players have distinct IDs and recovery revokes the old device", () => {
  const fixture = newTestDb();
  try {
    const a = registerPlayer(fixture.db, identity, 100);
    const b = registerPlayer(fixture.db, identity, 101);
    assert.notEqual(a.playerId, b.playerId);
    const code = createRecoveryCode(fixture.db, a.playerId, 102);
    const newToken = redeemRecoveryCode(fixture.db, code, 103);
    assert.equal(resolvePlayer(fixture.db, a.sessionToken), null);
    assert.equal(resolvePlayer(fixture.db, newToken), a.playerId);
    assert.throws(() => redeemRecoveryCode(fixture.db, code, 104));
  } finally { fixture.close(); }
});

test("only 2019–2025 and the four teams can register", () => {
  assert.throws(() => validateRegistration({ ...identity, grade: 2018 }));
  assert.throws(() => validateRegistration({ ...identity, grade: 2026 }));
  assert.throws(() => validateRegistration({ ...identity, team: "other" }));
  assert.equal(validateRegistration(identity).nickname, "PLAYER");
});

test("registration sets an opaque cookie and player credentials cannot operate admin routes", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("local-admin-secret")
  });
  const url = await app.listen(0, "127.0.0.1");
  try {
    const registered = await fetch(`${url}/api/players`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xlab-action": "1" },
      body: JSON.stringify({ ...identity, password: "valid-player-password" })
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.ok(!JSON.stringify(await registered.json()).includes("sessionToken"));
    const me = await fetch(`${url}/api/me`, { headers: { cookie } });
    assert.equal((await me.json()).nickname, "PLAYER");
    const admin = await fetch(`${url}/api/admin/players/no/recover`, {
      method: "POST",
      headers: { cookie, "x-xlab-action": "1" }
    });
    assert.equal(admin.status, 401);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("admin login is separate and recovery moves an existing account to a new device once", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 2_000, {
    adminPasswordHash: hashAdminPassword("correct-admin-secret")
  });
  const url = await app.listen(0, "127.0.0.1");
  const post = (path, body, cookie) => fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const player = await post("/api/players", { ...identity, password: "valid-player-password" });
    const { id } = await player.json();
    const oldCookie = player.headers.get("set-cookie");
    assert.equal((await post("/api/admin/login", { password: "wrong" })).status, 401);
    const login = await post("/api/admin/login", { password: "correct-admin-secret" });
    assert.equal(login.status, 200);
    const adminCookie = login.headers.get("set-cookie");
    const recovery = await post(`/api/admin/players/${id}/recover`, {}, adminCookie);
    assert.equal(recovery.status, 200);
    const { code } = await recovery.json();
    const redeemed = await post("/api/players/recover", {
      code, password: "new-player-password"
    });
    assert.equal(redeemed.status, 200);
    const newCookie = redeemed.headers.get("set-cookie");
    assert.equal((await fetch(`${url}/api/me`, { headers: { cookie: oldCookie } })).status, 401);
    assert.equal((await fetch(`${url}/api/me`, { headers: { cookie: newCookie } })).status, 200);
    assert.equal((await post("/api/players/recover", {
      code, password: "new-player-password"
    })).status, 409);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("a state change from a foreign origin is rejected even with the action header", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000);
  const url = await app.listen(0, "127.0.0.1");
  try {
    const response = await fetch(`${url}/api/players`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xlab-action": "1",
        origin: "https://foreign.example"
      },
      body: JSON.stringify(identity)
    });
    assert.equal(response.status, 403);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM players").get().count, 0);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("failed administrator attempts cannot lock the operator out behind a shared proxy", async () => {
  const fixture = newTestDb();
  let now = 1_000;
  const app = buildApp(fixture.db, () => now, {
    adminPasswordHash: hashAdminPassword("correct-admin-secret")
  });
  const url = await app.listen(0, "127.0.0.1");
  const login = (password) => fetch(`${url}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1" },
    body: JSON.stringify({ password })
  });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login("wrong")).status, 401);
    assert.equal((await login("correct-admin-secret")).status, 200);
  } finally {
    await app.close();
    fixture.close();
  }
});
