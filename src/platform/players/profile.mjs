import { httpError } from "../http/errors.mjs";

function invalid(path, message) {
  const error = httpError(400, message, { path });
  error.path = path;
  throw error;
}

export function validateProfile(fields, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    invalid("profile", "报名资料格式无效");
  }
  const configured = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!configured.has(key)) invalid(`profile.${key}`, "报名资料包含未知字段");
  }
  const profile = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) invalid(`profile.${field.key}`, "请填写必填字段");
      continue;
    }
    if (typeof value !== "string") invalid(`profile.${field.key}`, "字段内容应为文字");
    const clean = value.trim();
    if (!clean) {
      if (field.required) invalid(`profile.${field.key}`, "请填写必填字段");
      continue;
    }
    if (field.type === "text") {
      const count = Array.from(clean).length;
      if (count < field.minLength || count > field.maxLength || count > 120) {
        invalid(`profile.${field.key}`, "字段长度不符合报名要求");
      }
    } else if (field.type === "select") {
      if (!field.options.includes(clean)) {
        invalid(`profile.${field.key}`, "请选择有效选项");
      }
    } else {
      invalid(`profile.${field.key}`, "字段类型无效");
    }
    profile[field.key] = clean;
  }
  return profile;
}
