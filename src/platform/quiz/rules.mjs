import { httpError } from "../http/errors.mjs";

const size = (value) => Array.from(value).length;

function invalid(path, message) {
  const error = httpError(400, message);
  error.path = path;
  throw error;
}

export function normalizeExact(value) {
  return value.normalize("NFKC").trim()
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function validateQuestion(input) {
  const index = Number.isInteger(input?.position) && input.position > 0 ? input.position - 1 : 0;
  const path = `questions[${index}]`;
  if (!Number.isInteger(input?.position) || input.position < 1) {
    invalid(`${path}.position`, "题目序号无效");
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim() || size(input.prompt.trim()) > 500) {
    invalid(`${path}.prompt`, "题干长度必须为 1–500 字");
  }
  if (!Number.isInteger(input.points) || input.points < 0 || input.points > 10_000) {
    invalid(`${path}.points`, "题目分值须为 0–10000 的整数");
  }
  const { kind } = input;
  if (!["choice", "multiple", "exact", "length"].includes(kind)) {
    invalid(`${path}.kind`, "题型不受支持");
  }
  const result = {
    position: input.position, kind, prompt: input.prompt.trim(), points: input.points
  };
  let options;
  if (kind === "choice" || kind === "multiple") {
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 6
      || input.options.some((option) => typeof option !== "string" || !option.trim()
        || size(option.trim()) > 200)) {
      invalid(`${path}.options`, "选项须为 2–6 个有效文本");
    }
    options = input.options.map((option) => option.trim());
    if (new Set(options).size !== options.length) {
      invalid(`${path}.options`, "选项不能重复");
    }
    result.options = options;
  }
  const rule = input.answerRule ?? (kind === "choice"
    ? { correctOption: input.correctOption } : null);
  if (kind === "choice") {
    if (!Number.isInteger(rule?.correctOption)
      || rule.correctOption < 0 || rule.correctOption >= options.length) {
      invalid(`${path}.answerRule.correctOption`, "正确选项无效");
    }
    result.answerRule = { correctOption: rule.correctOption };
  } else if (kind === "multiple") {
    const values = rule?.correctOptions;
    if (!Array.isArray(values) || values.length < 1
      || values.some((value) => !Number.isInteger(value)
        || value < 0 || value >= options.length)
      || new Set(values).size !== values.length) {
      invalid(`${path}.answerRule.correctOptions`, "正确选项无效或重复");
    }
    result.answerRule = { correctOptions: [...values].sort((a, b) => a - b) };
  } else if (kind === "exact") {
    const values = rule?.accepted;
    if (!Array.isArray(values) || values.length < 1 || values.length > 10
      || values.some((value) => typeof value !== "string" || !value.trim()
        || size(value.trim()) > 120)) {
      invalid(`${path}.answerRule.accepted`, "可接受答案须为 1–10 个、每个不超过 120 字");
    }
    const accepted = values.map((value) => value.trim());
    if (new Set(accepted.map(normalizeExact)).size !== accepted.length) {
      invalid(`${path}.answerRule.accepted`, "规范化后的标准答案不能重复");
    }
    result.answerRule = { accepted };
  } else {
    const { minLength, maxLength } = rule ?? {};
    if (!Number.isInteger(minLength) || !Number.isInteger(maxLength)
      || minLength < 1 || maxLength > 120 || minLength > maxLength) {
      invalid(`${path}.answerRule`, "字数范围必须介于 1–120 字");
    }
    result.answerRule = { minLength, maxLength };
  }
  return result;
}

export function validateAnswer(question, value) {
  if (value === undefined || value === null || value === "") return;
  if (question.kind === "choice") {
    if (!Number.isInteger(value) || value < 0 || value >= question.options.length) {
      invalid("answer", "单选答案无效");
    }
  } else if (question.kind === "multiple") {
    if (!Array.isArray(value) || value.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= question.options.length)) {
      invalid("answer", "多选答案无效");
    }
    if (new Set(value).size !== value.length) invalid("answer", "多选答案不能重复");
  } else if (question.kind === "exact" || question.kind === "length") {
    if (typeof value !== "string" || size(value) > 120) {
      invalid("answer", "填写答案不得超过 120 字");
    }
  } else {
    invalid("answer", "题型不受支持");
  }
}

export function scoreAnswer(question, value, voided = false) {
  if (voided || value === undefined || value === null || value === ""
    || Array.isArray(value) && value.length === 0) return 0;
  validateAnswer(question, value);
  if (question.kind === "choice") {
    return value === question.answerRule.correctOption ? question.points : 0;
  }
  if (question.kind === "multiple") {
    const selected = [...value].sort((a, b) => a - b);
    const correct = question.answerRule.correctOptions;
    return selected.length === correct.length
      && selected.every((option, index) => option === correct[index]) ? question.points : 0;
  }
  if (question.kind === "exact") {
    return question.answerRule.accepted.some((answer) =>
      normalizeExact(answer) === normalizeExact(value)) ? question.points : 0;
  }
  const count = size(value.trim());
  return count >= question.answerRule.minLength && count <= question.answerRule.maxLength
    ? question.points : 0;
}

export function maxAnswerBytes(questions) {
  if (!Array.isArray(questions)) invalid("round.questions", "题目列表无效");
  let bytes = 700;
  for (const question of questions) {
    bytes += 48;
    if (question.kind === "exact") bytes += 6 * 120;
    else if (question.kind === "length") bytes += 6 * question.answerRule.maxLength;
    else if (question.kind === "multiple") bytes += 24;
    else bytes += 4;
  }
  if (bytes >= 65_536) invalid("round.questions", "本轮最大答卷超过 64 KiB");
  return bytes;
}
