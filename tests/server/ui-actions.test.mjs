import { test } from "node:test";
import assert from "node:assert/strict";
import { runAdminAction } from "../../public/js/admin-actions.mjs";

test("a one-time recovery code remains visible after refresh", async () => {
  const messages = [];
  const result = await runAdminAction(
    async () => "玩家的一次性恢复码：LOCAL-TEST",
    "常规成功",
    (text) => messages.push(text),
    async () => messages.push("refreshed")
  );
  assert.equal(result, true);
  assert.deepEqual(messages, ["玩家的一次性恢复码：LOCAL-TEST", "refreshed"]);
});

test("a failed admin operation shows the error without claiming success", async () => {
  const messages = [];
  const result = await runAdminAction(
    async () => { throw new Error("操作失败"); },
    "常规成功",
    (text, error) => messages.push([text, error]),
    async () => messages.push(["refreshed", false])
  );
  assert.equal(result, false);
  assert.deepEqual(messages, [["操作失败", true]]);
});
