import { createHash, randomBytes } from "node:crypto";
import { httpError } from "../http/errors.mjs";

export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function sessionCookie(name, token, secure) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(name, secure) {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;
}

export async function requireOrganizer(pool, req) {
  const token = cookieValue(req, "organizer_session");
  if (!token) throw httpError(401, "请先登录组织者账号");
  const result = await pool.query(`SELECT o.id,o.login,o.platform_admin
    FROM organizer_sessions s JOIN organizers o ON o.id=s.organizer_id
    WHERE s.token_hash=$1 AND s.expires_at>$2`,
  [tokenHash(token), Date.now()]);
  if (!result.rowCount) throw httpError(401, "组织者登录已失效");
  return result.rows[0];
}
