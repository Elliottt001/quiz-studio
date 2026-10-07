import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/server/app.mjs";
import { newTestDb } from "./helpers.mjs";

test("the player page exposes the four-field entry flow at a mobile viewport", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 100);
  const url = await app.listen(0, "127.0.0.1");
  try {
    const html = await (await fetch(url)).text();
    for (const name of ["真名", "昵称", "年级", "团队", "进入游戏"]) {
      assert.ok(html.includes(name), `${name} must be visible in the entry page`);
    }
    assert.match(html, /已有账号登录/);
    assert.match(html, /name="password"/);
    assert.match(html, /id="login-form"/);
    assert.match(html, /id="logout-button"/);
    assert.match(html, /id="switch-account-button"/);
    assert.match(html, /href="\/admin\.html"/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /infinity-ribbon\.webp/);
    assert.ok(!html.includes("地点地点地点"));
    assert.match(html, /id="register-form"[^>]*method="post"/);
    assert.match(html, /id="recovery-form"[^>]*method="post"/);
    const image = await fetch(`${url}/brand/infinity-ribbon.webp`);
    assert.equal(image.headers.get("content-type"), "image/webp");
    assert.ok((await image.arrayBuffer()).byteLength > 10_000);
    const script = await fetch(`${url}/js/player.mjs`);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  } finally {
    await app.close();
    fixture.close();
  }
});

test("operator and stage pages are separate responsive views without public edit controls", async () => {
  const fixture = newTestDb();
  const app = buildApp(fixture.db, () => 100);
  const url = await app.listen(0, "127.0.0.1");
  try {
    const admin = await (await fetch(`${url}/admin.html`)).text();
    const stage = await (await fetch(`${url}/display.html`)).text();
    assert.match(admin, /name="viewport"/);
    assert.match(admin, /开始第一轮/);
    assert.match(admin, /导入题库/);
    assert.match(admin, /作废单题/);
    assert.match(admin, /撤销误录加分/);
    assert.match(admin, /id="login-form"[^>]*method="post"/);
    assert.match(stage, /infinity-ribbon\.webp/);
    assert.match(stage, /开奖/);
    assert.ok(!stage.includes("导入题库"));
    assert.ok(!stage.includes("地点地点地点"));
  } finally {
    await app.close();
    fixture.close();
  }
});
