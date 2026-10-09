import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCampusProxy } from "../../src/server/config.mjs";
import { probeGame } from "../../scripts/verify-campus.mjs";
import { newTestDb } from "./helpers.mjs";
import { buildApp } from "../../src/server/app.mjs";

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
