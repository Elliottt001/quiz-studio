import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAdminHash } from "../../scripts/admin-password.mjs";
import { verifyAdminPassword } from "../../src/server/auth.mjs";

test("operator password setup creates a verifiable hash without keeping plaintext", () => {
  const plain = "一串仅供现场管理员使用的随机口令";
  const hash = makeAdminHash(plain);
  assert.equal(hash.includes(plain), false);
  assert.equal(verifyAdminPassword(plain, hash), true);
  assert.equal(verifyAdminPassword("wrong", hash), false);
});

test("operator password setup rejects weak or empty phrases", () => {
  for (const password of ["", "short", "1234567890"]) {
    assert.throws(() => makeAdminHash(password), /至少/);
  }
});
