import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateQuestion, validateAnswer, scoreAnswer, maxAnswerBytes, normalizeExact
} from "../../src/platform/quiz/rules.mjs";

const choice = {
  position: 1, kind: "choice", prompt: "2+2?", options: ["3", "4"],
  correctOption: 1, points: 7
};

test("choice, multiselect and exact text use deterministic full-score rules", () => {
  const first = validateQuestion(choice);
  assert.deepEqual(first.answerRule, { correctOption: 1 });
  assert.equal(scoreAnswer(first, 1), 7);
  assert.equal(scoreAnswer(first, 0), 0);

  const multiple = validateQuestion({
    position: 2, kind: "multiple", prompt: "Which?", options: ["A", "B", "C"],
    answerRule: { correctOptions: [2, 0] }, points: 7
  });
  assert.deepEqual(multiple.answerRule.correctOptions, [0, 2]);
  assert.equal(scoreAnswer(multiple, [2, 0]), 7);
  assert.equal(scoreAnswer(multiple, [0]), 0);
  assert.equal(scoreAnswer(multiple, [0, 1]), 0);
  assert.throws(() => validateAnswer(multiple, [0, 0]), (error) =>
    error.status === 400 && /重复/.test(error.message));
  assert.throws(() => validateAnswer(multiple, [3]), (error) =>
    error.status === 400 && error.path === "answer");

  const exact = validateQuestion({
    position: 3, kind: "exact", prompt: "Name?", answerRule: { accepted: ["ＡBC", "Ada"] },
    points: 7
  });
  assert.equal(normalizeExact("  ＡBc  "), "abc");
  assert.equal(scoreAnswer(exact, " abc "), 7);
  assert.equal(scoreAnswer(exact, "ADA"), 7);
  assert.equal(scoreAnswer(exact, "Ａ BC"), 0);
  assert.throws(() => validateAnswer(exact, "甲".repeat(121)), (error) =>
    error.status === 400 && error.path === "answer");
});

test("length gifts count Unicode code points, while omissions and voids score zero", () => {
  const length = validateQuestion({
    position: 1, kind: "length", prompt: "感受", points: 10,
    answerRule: { minLength: 5, maxLength: 120 }
  });
  assert.equal(Array.from("😀").length, 1);
  assert.equal(scoreAnswer(length, " 甲乙丙丁😀 "), 10);
  assert.equal(scoreAnswer(length, "甲乙丙丁"), 0);
  assert.equal(scoreAnswer(length, "甲".repeat(120)), 10);
  assert.throws(() => validateAnswer(length, "甲".repeat(121)), (error) =>
    error.status === 400 && error.path === "answer");
  assert.equal(scoreAnswer(length, undefined), 0);
  assert.equal(scoreAnswer(length, "甲乙丙丁😀", true), 0);
});

test("invalid rules report the question field and bound maximum JSON bytes", () => {
  assert.throws(() => validateQuestion({
    ...choice, options: ["only"]
  }), (error) => error.status === 400 && error.path === "questions[0].options");
  assert.throws(() => validateQuestion({
    ...choice, kind: "multiple", answerRule: { correctOptions: [0, 0] }
  }), (error) => error.status === 400 && error.path === "questions[0].answerRule.correctOptions");
  assert.throws(() => validateQuestion({
    position: 1, kind: "exact", prompt: "Alias", points: 7,
    answerRule: { accepted: ["ABC", "ＡＢＣ"] }
  }), (error) => error.status === 400 && /重复/.test(error.message));
  assert.throws(() => validateQuestion({
    position: 1, kind: "length", prompt: "Too short", points: 7,
    answerRule: { minLength: 20, maxLength: 5 }
  }), (error) => error.status === 400 && error.path === "questions[0].answerRule");
  const normal = validateQuestion({
    position: 1, kind: "length", prompt: "Note", points: 10,
    answerRule: { minLength: 1, maxLength: 120 }
  });
  assert.ok(maxAnswerBytes([normal]) < 65_536);
  assert.throws(() => maxAnswerBytes(Array.from({ length: 100 }, () => normal)),
    (error) => error.status === 400 && error.path === "round.questions");
});
