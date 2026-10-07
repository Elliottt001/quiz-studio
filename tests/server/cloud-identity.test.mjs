import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/server/app.mjs";
import { newTestDb } from "./helpers.mjs";
import { hashAdminPassword } from "../../src/server/auth.mjs";

const identity = {
  realName: "测试同学", nickname: "玩家", grade: 2025, team: "software",
  password: "player-secret-123"
};

test("a player registers once and logs in on another computer using code and password", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("administrator-secret"),
    publicOrigin: "https://x-lab.game.elliotttzhang.cn",
    tlsTerminated: true
  });
  const base = await app.listen(0, "127.0.0.1");
  const post = (path, body, cookie, origin = "https://x-lab.game.elliotttzhang.cn") =>
    fetch(base + path, {
      method: "POST",
      headers: {
        origin, "content-type": "application/json", "x-xlab-action": "1",
        ...(cookie ? { cookie } : {})
      },
      body: JSON.stringify(body)
    });
  try {
    assert.equal((await post("/api/players", { ...identity, password: "" })).status, 400);
    const registration = await post("/api/players", identity);
    assert.equal(registration.status, 201);
    assert.match(registration.headers.get("set-cookie"), /Secure/);
    const account = await registration.json();
    assert.match(account.loginCode, /^[A-Z0-9]{10,16}$/);
    assert.equal(JSON.stringify(account).includes(identity.password), false);
    assert.equal((await post("/api/players/login", { loginCode: account.loginCode, password: "wrong" })).status, 401);
    const login = await post("/api/players/login", {
      loginCode: account.loginCode, password: identity.password
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.equal((await (await fetch(base + "/api/me", { headers: { cookie } })).json()).id, account.id);
    const logout = await post("/api/players/logout", {}, cookie);
    assert.equal(logout.status, 200);
    assert.equal((await fetch(base + "/api/me", { headers: { cookie } })).status, 401);
    assert.equal((await post("/api/players/login", {
      loginCode: account.loginCode, password: identity.password
    }, undefined, "https://other.example")).status, 403);
    const staged = await post("/api/players/login", {
      loginCode: account.loginCode, password: identity.password
    }, undefined, new URL(base).origin.replace("http:", "https:"));
    assert.equal(staged.status, 403);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("existing player records migrate without losing score or granting name-only access", async () => {
  const fixture = newTestDb();
  try {
    const old = fixture.db.prepare("SELECT id FROM players LIMIT 1").get();
    assert.equal(old, undefined);
    const columns = fixture.db.prepare("PRAGMA table_info(players)").all().map((column) => column.name);
    assert.ok(columns.includes("login_code"));
    assert.ok(columns.includes("password_hash"));
  } finally { fixture.close(); }
});

test("public proxy mode permits an internal listener only with HTTPS origin and admin hash", async () => {
  const fixture = newTestDb();
  try {
    const app = buildApp(fixture.db, Date.now, {
      adminPasswordHash: hashAdminPassword("administrator-secret"),
      publicOrigin: "https://x-lab.game.elliotttzhang.cn",
      tlsTerminated: true
    });
    const url = await app.listen(0, "0.0.0.0");
    const response = await fetch(url.replace("0.0.0.0", "127.0.0.1") + "/api/health");
    assert.equal(response.status, 200);
    await app.close();
    assert.throws(() => buildApp(fixture.db, Date.now, {
      publicOrigin: "http://x-lab.game.elliotttzhang.cn", tlsTerminated: true
    }), /HTTPS/);
  } finally { fixture.close(); }
});

test("preview ingress requires an explicitly configured HTTPS origin", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("administrator-secret"),
    publicOrigin: "https://x-lab.game.elliotttzhang.cn",
    previewOrigin: "https://xlab-quiz-preview.onrender.com",
    tlsTerminated: true
  });
  const base = await app.listen(0, "127.0.0.1");
  const register = (origin, host) => fetch(base + "/api/players", {
    method: "POST",
    headers: { origin, host, "content-type": "application/json", "x-xlab-action": "1" },
    body: JSON.stringify({ ...identity, realName: origin, password: "player-secret-123" })
  });
  try {
    assert.equal((await register("https://xlab-quiz-preview.onrender.com", "xlab-quiz-preview.onrender.com")).status, 201);
    assert.equal((await register("https://attacker.example", "attacker.example")).status, 403);
    assert.equal((await register("http://xlab-quiz-preview.onrender.com", "xlab-quiz-preview.onrender.com")).status, 403);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("admin logs out from a shared computer and its old cookie loses admin access", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("administrator-secret")
  });
  const base = await app.listen(0, "127.0.0.1");
  try {
    const login = await fetch(base + "/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-xlab-action": "1" },
      body: JSON.stringify({ password: "administrator-secret" })
    });
    const cookie = login.headers.get("set-cookie");
    assert.equal((await fetch(base + "/api/admin/session", { headers: { cookie } })).status, 200);
    const logout = await fetch(base + "/api/admin/logout", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-xlab-action": "1" },
      body: "{}"
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(base + "/api/admin/session", { headers: { cookie } })).status, 401);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("weak password does not consume a staff-issued account recovery code", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("administrator-secret")
  });
  const base = await app.listen(0, "127.0.0.1");
  const { registerPlayer, createRecoveryCode } = await import("../../src/server/auth.mjs");
  const player = registerPlayer(fixture.db, {
    realName: "早期玩家", nickname: "OLD", grade: 2024, team: "design"
  }, 500);
  const code = createRecoveryCode(fixture.db, player.playerId, 600);
  const recover = (password) => fetch(base + "/api/players/recover", {
    method: "POST", headers: { "content-type": "application/json", "x-xlab-action": "1" },
    body: JSON.stringify({ code, password })
  });
  try {
    assert.equal((await recover("weak")).status, 400);
    const valid = await recover("new-player-password");
    assert.equal(valid.status, 200);
    assert.ok((await valid.json()).loginCode);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("staff recovery upgrades legacy credentials and revokes admin on shared browser", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("administrator-secret")
  });
  const base = await app.listen(0, "127.0.0.1");
  const { registerPlayer, createRecoveryCode } = await import("../../src/server/auth.mjs");
  const old = registerPlayer(fixture.db, {
    realName: "老玩家", nickname: "OLD", grade: 2023, team: "hardware"
  }, 100);
  const code = createRecoveryCode(fixture.db, old.playerId, 500);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const admin = await post("/api/admin/login", { password: "administrator-secret" });
    const adminCookie = admin.headers.get("set-cookie");
    assert.equal((await post("/api/players/recover", { code }, adminCookie)).status, 400);
    const restored = await post("/api/players/recover", {
      code, password: "new-legacy-password"
    }, adminCookie);
    assert.equal(restored.status, 200);
    const { loginCode } = await restored.json();
    assert.match(loginCode, /^[A-F0-9]{16}$/);
    assert.equal((await fetch(base + "/api/admin/session", { headers: { cookie: adminCookie } })).status, 401);
    assert.equal((await post("/api/players/login", {
      loginCode, password: "new-legacy-password"
    })).status, 200);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("switching roles on one shared browser revokes the previous role's session", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000, {
    adminPasswordHash: hashAdminPassword("administrator-secret")
  });
  const base = await app.listen(0, "127.0.0.1");
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const adminLogin = await post("/api/admin/login", { password: "administrator-secret" });
    const oldAdminCookie = adminLogin.headers.get("set-cookie");
    const registration = await post("/api/players", identity, oldAdminCookie);
    const { loginCode } = await registration.json();
    assert.equal(registration.status, 201);
    assert.equal((await fetch(base + "/api/admin/session", { headers: { cookie: oldAdminCookie } })).status, 401);
    const playerCookie = registration.headers.get("set-cookie");
    const adminAgain = await post("/api/admin/login", { password: "administrator-secret" }, playerCookie);
    assert.equal(adminAgain.status, 200);
    assert.equal((await fetch(base + "/api/me", { headers: { cookie: playerCookie } })).status, 401);
    assert.match(loginCode, /^[A-F0-9]{16}$/);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("switching ordinary players on a shared computer revokes the previous player's session", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 1_000);
  const base = await app.listen(0, "127.0.0.1");
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const first = await post("/api/players", identity);
    const firstCookie = first.headers.get("set-cookie");
    const second = await post("/api/players", { ...identity, realName: "另一名同学" }, firstCookie);
    const secondCookie = second.headers.get("set-cookie");
    assert.equal(second.status, 201);
    assert.equal((await fetch(base + "/api/me", { headers: { cookie: firstCookie } })).status, 401);
    assert.equal((await fetch(base + "/api/me", { headers: { cookie: secondCookie } })).status, 200);
  } finally {
    await app.close();
    fixture.close();
  }
});
