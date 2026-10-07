import { test } from "node:test";
import assert from "node:assert/strict";
import { submitButtonState } from "../../public/js/submit-state.mjs";

test("a pending confirmed-time attempt remains retryable after the countdown", () => {
  assert.deepEqual(submitButtonState(-100, "same-key", false), {
    disabled: false, label: "重试确认交卷"
  });
  assert.deepEqual(submitButtonState(-100, null, false), {
    disabled: true, label: "本轮已截止"
  });
});

test("a pending request cannot be double clicked while in flight", () => {
  assert.deepEqual(submitButtonState(10_000, "same-key", true), {
    disabled: true, label: "正在确认交卷"
  });
});
