import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/password.mjs";
import { newToken, tokenHash } from "../auth/sessions.mjs";
import { httpError } from "../http/errors.mjs";

export async function createOrganizer(pool, { login, password, platformAdmin = false }) {
  const normalized = typeof login === "string" ? login.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{3,32}$/.test(normalized)) throw httpError(400, "组织者登录名无效");
  const hash = await hashPassword(password);
  const id = randomUUID();
  try {
    await pool.query(`INSERT INTO organizers(id,login,password_hash,platform_admin)
      VALUES($1,$2,$3,$4)`, [id, normalized, hash, platformAdmin]);
  } catch (error) {
    if (error.code === "23505") throw httpError(409, "登录名已被使用");
    throw error;
  }
  return { id, login: normalized, platformAdmin };
}

export async function loginOrganizer(pool, login, password, now) {
  const normalized = typeof login === "string" ? login.trim().toLowerCase() : "";
  const row = (await pool.query(`SELECT id,password_hash FROM organizers WHERE login=$1`, [normalized])).rows[0];
  if (!row || !await verifyPassword(password, row.password_hash)) {
    throw httpError(401, "组织者账号或密码错误");
  }
  const token = newToken();
  await pool.query(`INSERT INTO organizer_sessions(token_hash,organizer_id,created_at,expires_at)
    VALUES($1,$2,$3,$4)`, [tokenHash(token), row.id, now, now + 8 * 60 * 60_000]);
  return token;
}

export async function logoutOrganizer(pool, token) {
  if (!token) throw httpError(401, "组织者尚未登录");
  const result = await pool.query("DELETE FROM organizer_sessions WHERE token_hash=$1",
    [tokenHash(token)]);
  if (!result.rowCount) throw httpError(401, "组织者登录已失效");
}
