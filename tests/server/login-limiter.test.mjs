import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginLimiter } from "../../src/server/login-limiter.mjs";

test("invalid login codes never allocate rate-limit entries", () => {
  const limiter = new LoginLimiter(8, 60_000, 300);
  for (let i = 0; i < 20_000; i++) {
    limiter.failure(`INVALID-${i}`, 100);
  }
  assert.equal(limiter.size, 0);
  limiter.failure("ABCDEF0123456789", 100);
  assert.equal(limiter.size, 1);
});

test("known-code limiter expires old entries and rejects an eighth repeat without unbounded storage", () => {
  const limiter = new LoginLimiter(8, 60_000, 300);
  for (let i = 0; i < 8; i++) limiter.failure("ABCDEF0123456789", 100);
  assert.equal(limiter.blocked("ABCDEF0123456789", 100), true);
  assert.equal(limiter.blocked("ABCDEF0123456789", 60_101), false);
  assert.equal(limiter.size, 0);
});
