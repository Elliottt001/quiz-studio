import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

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
