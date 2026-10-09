import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCampusProxy, validateCampusHttp } from "../../src/server/config.mjs";
import { probeGame, validGameOrigin } from "../../scripts/verify-campus.mjs";
import { newTestDb } from "./helpers.mjs";
import { buildApp } from "../../src/server/app.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { hashAdminPassword } from "../../src/server/auth.mjs";

const campus = {
  CAMPUS_PROXY_ONLY: "1",
  HOST: "127.0.0.1",
  TRUSTED_HTTPS_PROXY: "1",
  PUBLIC_ORIGIN: "https://x-lab.game.elliotttzhang.cn",
  ADMIN_PASSWORD_HASH: "a-configured-hash",
  DATA_DIR: "/var/lib/xlab-annual-quiz"
};

test("campus mode refuses an exposed plaintext listener and incomplete TLS proxy settings", () => {
  assert.doesNotThrow(() => validateCampusProxy(campus));
  assert.doesNotThrow(() => validateCampusProxy({
    ...campus, PUBLIC_ORIGIN: "https://quiz.campus.example.edu.cn"
  }));
  for (const changes of [
    { HOST: "0.0.0.0" },
    { HOST: "::1" },
    { TRUSTED_HTTPS_PROXY: "0" },
    { PUBLIC_ORIGIN: "http://x-lab.game.elliotttzhang.cn" },
    { TLS_CERT_PATH: "/tmp/cert.pem", TLS_KEY_PATH: "/tmp/key.pem" },
    { ADMIN_PASSWORD_HASH: "" },
    { DATA_DIR: "data" }
  ]) {
    assert.throws(() => validateCampusProxy({ ...campus, ...changes }));
  }
  assert.doesNotThrow(() => validateCampusProxy({ HOST: "0.0.0.0" }));
});

test("campus probe accepts a complete game server, not just its public page", async () => {
  const state = newTestDb();
  const app = buildApp(state.db);
  const base = await app.listen(0, "127.0.0.1");
  try {
    assert.deepEqual(await probeGame(base), {
      health: true, player: true, admin: true, display: true
    });
  } finally {
    await app.close();
    state.close();
  }
});

test("campus probe rejects the old Pages introduction without a working API", async () => {
  await assert.rejects(
    () => probeGame("https://x-lab.game.elliotttzhang.cn", async () =>
      new Response("<main>说明页</main>", {
        status: 200, headers: { "content-type": "text/html" }
      })),
    /健康检查|完整游戏/
  );
});

test("campus verification requires an explicit game entry instead of assuming Pages", () => {
  const run = spawnSync(process.execPath, [resolve("scripts/verify-campus.mjs")], {
    env: { PATH: process.env.PATH }, encoding: "utf8"
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /请指定.*入口/);
});

const campusHttp = {
  CAMPUS_HTTP_ONLY: "1",
  HOST: "0.0.0.0",
  PORT: "4173",
  DATA_DIR: "/var/lib/xlab-annual-quiz",
  ADMIN_PASSWORD_HASH: hashAdminPassword("administrator-secret")
};

test("campus HTTP requires explicit standalone configuration, not a proxy fallback", () => {
  assert.doesNotThrow(() => validateCampusHttp(campusHttp));
  for (const changes of [
    { HOST: "127.0.0.1" },
    { PORT: "0" },
    { PORT: "65536" },
    { DATA_DIR: "data" },
    { ADMIN_PASSWORD_HASH: "" },
    { ADMIN_PASSWORD_HASH: "replace-with-output-of-admin-password-script" },
    { PUBLIC_ORIGIN: "https://example.com" },
    { PREVIEW_ORIGIN: "https://preview.example.com" },
    { TRUSTED_HTTPS_PROXY: "1" },
    { CAMPUS_PROXY_ONLY: "1" },
    { TLS_CERT_PATH: "/tmp/cert.pem" }
  ]) {
    assert.throws(() => validateCampusHttp({ ...campusHttp, ...changes }));
  }
});

test("campus HTTP direct listener supports same-origin player and admin sessions", async () => {
  const fixture = newTestDb();
  const passwordHash = campusHttp.ADMIN_PASSWORD_HASH;
  const app = buildApp(fixture.db, Date.now, {
    campusHttpOnly: true, adminPasswordHash: passwordHash
  });
  const url = await app.listen(0, "0.0.0.0");
  const base = url.replace("0.0.0.0", "127.0.0.1");
  const origin = new URL(base).origin;
  const post = (path, body, requestOrigin = origin) => fetch(base + path, {
    method: "POST",
    headers: { origin: requestOrigin, "x-xlab-action": "1", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const registration = await post("/api/players", {
      realName: "测试同学", nickname: "玩家", grade: 2025, team: "software",
      password: "player-secret-123"
    });
    assert.equal(registration.status, 201);
    assert.match(registration.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(registration.headers.get("set-cookie"), /Secure/);
    const admin = await post("/api/admin/login", { password: "administrator-secret" });
    assert.equal(admin.status, 200);
    assert.doesNotMatch(admin.headers.get("set-cookie"), /Secure/);
    assert.equal((await post("/api/admin/login", { password: "administrator-secret" },
      "http://attacker.example")).status, 403);
  } finally {
    await app.close();
    fixture.close();
  }
});

test("campus verifier refuses public plaintext and accepts only private IPv4 HTTP targets", () => {
  assert.equal(validGameOrigin("http://8.8.8.8:4173"), false);
  assert.equal(validGameOrigin("http://localhost:4173"), false);
  assert.equal(validGameOrigin("http://192.168.1.10:4173"), true);
  assert.equal(validGameOrigin("http://172.31.1.2:4173"), true);
  assert.equal(validGameOrigin("http://10.12.34.56:4173"), true);
  assert.equal(validGameOrigin("http://10.12.34.56:4173/admin.html"), false);
});
