import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { httpError } from "../http/errors.mjs";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password, minLength = 10) {
  if (typeof password !== "string" || password.length < minLength || password.length > 128) {
    throw httpError(400, `密码需要 ${minLength}–128 个字符`);
  }
  const salt = randomBytes(16).toString("hex");
  const digest = await scrypt(password, salt, 64);
  return `${salt}:${digest.toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") return false;
  const [salt, expected] = storedHash.split(":");
  if (!/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(expected ?? "")) return false;
  const digest = await scrypt(password, salt, 64);
  return timingSafeEqual(digest, Buffer.from(expected, "hex"));
}
