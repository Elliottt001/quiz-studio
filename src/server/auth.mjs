import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { transaction } from "./db.mjs";

const teams = new Set(["software", "hardware", "operations", "design"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function validateRegistration(input) {
  if (!input || typeof input !== "object") throw httpError(400, "请填写注册资料");
  const realName = typeof input.realName === "string" ? input.realName.trim() : "";
  const nickname = typeof input.nickname === "string" ? input.nickname.trim() : "";
  if (!realName || realName.length > 40) throw httpError(400, "请填写有效真名");
  if (!nickname || nickname.length > 24) throw httpError(400, "请填写有效昵称");
  if (!Number.isInteger(input.grade) || input.grade < 2019 || input.grade > 2025) {
    throw httpError(400, "年级仅支持2019至2025级");
  }
  if (!teams.has(input.team)) throw httpError(400, "请选择四个团队之一");
  return { realName, nickname, grade: input.grade, team: input.team };
}

export function validatePlayerPassword(password) {
  if (typeof password !== "string" || password.length < 10 || password.length > 128) {
    throw httpError(400, "玩家密码需为10–128个字符");
  }
  return password;
}

function createSession(db, playerId, now) {
  const sessionToken = token();
  db.prepare("INSERT INTO sessions(token_hash,player_id,created_at) VALUES(?,?,?)")
    .run(digest(sessionToken), playerId, now);
  return sessionToken;
}

export function registerPlayer(db, input, now) {
  const player = validateRegistration(input);
  const passwordHash = input.password === undefined ? null : hashAdminPassword(validatePlayerPassword(input.password));
  return transaction(db, () => {
    const playerId = randomUUID();
    const loginCode = randomBytes(8).toString("hex").toUpperCase();
    db.prepare(`INSERT INTO players(id,real_name,nickname,grade,team,created_at,login_code,password_hash)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(playerId, player.realName, player.nickname, player.grade, player.team, now, loginCode, passwordHash);
    db.prepare("INSERT INTO eligibility(player_id,updated_at) VALUES(?,?)").run(playerId, now);
    return { playerId, loginCode, sessionToken: createSession(db, playerId, now) };
  });
}

export function loginPlayer(db, loginCode, password, now) {
  const normalized = typeof loginCode === "string" ? loginCode.trim().toUpperCase() : "";
  const account = db.prepare("SELECT id,password_hash FROM players WHERE login_code=?").get(normalized);
  if (!account?.password_hash || !verifyAdminPassword(password, account.password_hash)) {
    throw httpError(401, "登录码或密码错误，请向现场工作人员核对");
  }
  return { playerId: account.id, sessionToken: createSession(db, account.id, now) };
}

export function logoutPlayer(db, sessionToken, now) {
  if (!sessionToken) throw httpError(401, "未登录");
  const result = db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL")
    .run(now, digest(sessionToken));
  if (!result.changes) throw httpError(401, "登录已失效");
}

export function resolvePlayer(db, sessionToken) {
  if (!sessionToken) return null;
  return db.prepare("SELECT player_id FROM sessions WHERE token_hash=? AND revoked_at IS NULL")
    .get(digest(sessionToken))?.player_id ?? null;
}

export function createRecoveryCode(db, playerId, now) {
  if (!db.prepare("SELECT id FROM players WHERE id=?").get(playerId)) {
    throw httpError(404, "玩家不存在");
  }
  const code = token();
  db.prepare("INSERT INTO recovery_codes(token_hash,player_id,expires_at) VALUES(?,?,?)")
    .run(digest(code), playerId, now + 10 * 60_000);
  return code;
}

export function redeemRecoveryCode(db, code, now) {
  if (typeof code !== "string" || !code) throw httpError(400, "恢复码无效");
  return transaction(db, () => {
    const row = db.prepare("SELECT player_id,expires_at,used_at FROM recovery_codes WHERE token_hash=?")
      .get(digest(code));
    if (!row || row.used_at !== null || row.expires_at < now) {
      throw httpError(409, "恢复码已使用或过期");
    }
    db.prepare("UPDATE recovery_codes SET used_at=? WHERE token_hash=?").run(now, digest(code));
    db.prepare("UPDATE sessions SET revoked_at=? WHERE player_id=? AND revoked_at IS NULL")
      .run(now, row.player_id);
    return createSession(db, row.player_id, now);
  });
}

export function setRecoveredPassword(db, playerId, password) {
  const passwordHash = hashAdminPassword(validatePlayerPassword(password));
  const loginCode = db.prepare("SELECT login_code FROM players WHERE id=?").get(playerId)?.login_code;
  if (!loginCode) throw httpError(404, "玩家不存在");
  db.prepare("UPDATE players SET password_hash=? WHERE id=?").run(passwordHash, playerId);
  return loginCode;
}

export function hashAdminPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyAdminPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") return false;
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected || expected.length !== 128) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export function createAdminSession(db, now) {
  const sessionToken = token();
  db.prepare("INSERT INTO admin_sessions(token_hash,created_at,expires_at) VALUES(?,?,?)")
    .run(digest(sessionToken), now, now + 8 * 60 * 60_000);
  return sessionToken;
}

export function logoutAdmin(db, sessionToken) {
  if (!sessionToken) throw httpError(401, "管理员尚未登录");
  const result = db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(digest(sessionToken));
  if (!result.changes) throw httpError(401, "管理员登录已失效");
}

export function cookieValue(req, name) {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function requirePlayer({ req, db }) {
  const playerId = resolvePlayer(db, cookieValue(req, "player_session"));
  if (!playerId) throw httpError(401, "请先注册或恢复账号");
  return playerId;
}

export function requireAdmin({ req, db, clock }) {
  const value = cookieValue(req, "admin_session");
  const row = value && db.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash=?").get(digest(value));
  if (!row || row.expires_at <= clock()) throw httpError(401, "需要管理员登录");
  return "admin";
}

export function sessionCookie(name, value, secure = false) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
