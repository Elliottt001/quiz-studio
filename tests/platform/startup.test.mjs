import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bootstrapPlatformOwner } from "../../scripts/platform-bootstrap.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("bootstrap creates exactly one platform administrator and rejects a second", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const first = await bootstrapPlatformOwner(pool, {
      login: "platform-owner", password: "secure-platform-owner-phrase"
    });
    assert.equal(first.platformAdmin, true);
    await assert.rejects(bootstrapPlatformOwner(pool, {
      login: "another-owner", password: "secure-platform-owner-phrase"
    }), /已存在/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organizers WHERE platform_admin=true"))
      .rows[0].n, 1);
  } finally {
    await close();
  }
});

test("standalone runtime fails closed without a database URL", () => {
  const child = spawnSync(process.execPath, ["src/platform/main.mjs"], {
    env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8", timeout: 5_000
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /DATABASE_URL/);
});
