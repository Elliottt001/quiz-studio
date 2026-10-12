import { randomBytes, randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool.mjs";
import { hashPassword, verifyPassword } from "../auth/password.mjs";
import { cookieValue, newToken, tokenHash } from "../auth/sessions.mjs";
import { httpError } from "../http/errors.mjs";

const playerLifetimeMs = 30 * 24 * 60 * 60_000;

export async function publishedGame(pool, slug) {
  const row = (await pool.query(`SELECT id,slug FROM games
    WHERE slug=$1 AND status='published'`, [slug])).rows[0];
  if (!row) throw httpError(404, "游戏不存在或尚未开放");
  return row;
}

export async function registerPlayer(pool, gameId, input) {
  const displayName = typeof input?.displayName === "string" ? input.displayName.trim() : "";
  if (!displayName || displayName.length > 40) throw httpError(400, "请填写有效展示名");
  const passwordHash = await hashPassword(input?.password);
  return withTransaction(pool, async (client) => {
    const game = (await client.query(`SELECT id FROM games WHERE id=$1 AND status='published'`,
      [gameId])).rows[0];
    if (!game) throw httpError(404, "游戏不存在或尚未开放");
    const playerId = randomUUID();
    const loginCode = randomBytes(8).toString("hex").toUpperCase();
    const sessionToken = newToken();
    const now = Date.now();
    await client.query(`INSERT INTO players(game_id,id,display_name,login_code,password_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [gameId, playerId, displayName, loginCode, passwordHash, now]);
    await client.query(`INSERT INTO player_sessions
      (token_hash,game_id,player_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`,
    [tokenHash(sessionToken), gameId, playerId, now, now + playerLifetimeMs]);
    return { playerId, loginCode, sessionToken };
  });
}

export async function loginPlayer(pool, gameId, loginCode, password) {
  const code = typeof loginCode === "string" ? loginCode.trim().toUpperCase() : "";
  const row = (await pool.query(`SELECT id,password_hash FROM players
    WHERE game_id=$1 AND login_code=$2`, [gameId, code])).rows[0];
  if (!row || !await verifyPassword(password, row.password_hash)) {
    throw httpError(401, "登录码或密码不正确");
  }
  const sessionToken = newToken();
  const now = Date.now();
  await pool.query(`INSERT INTO player_sessions
    (token_hash,game_id,player_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`,
  [tokenHash(sessionToken), gameId, row.id, now, now + playerLifetimeMs]);
  return { playerId: row.id, sessionToken };
}

export async function requirePlayerForGame(pool, req, gameId) {
  const game = (await pool.query("SELECT slug FROM games WHERE id=$1", [gameId])).rows[0];
  if (!game) throw httpError(404, "游戏不存在");
  const token = cookieValue(req, `game_session_${game.slug}`);
  if (!token) throw httpError(401, "请加入本场游戏");
  const row = (await pool.query(`SELECT player_id FROM player_sessions
    WHERE token_hash=$1 AND game_id=$2 AND revoked_at IS NULL AND expires_at>$3`,
  [tokenHash(token), gameId, Date.now()])).rows[0];
  if (!row) throw httpError(401, "本场游戏的登录已失效");
  return row.player_id;
}

export async function logoutPlayer(pool, req, game) {
  const token = cookieValue(req, `game_session_${game.slug}`);
  if (!token) throw httpError(401, "尚未登录本场游戏");
  const result = await pool.query(`UPDATE player_sessions SET revoked_at=$3
    WHERE token_hash=$1 AND game_id=$2 AND revoked_at IS NULL RETURNING token_hash`,
  [tokenHash(token), game.id, Date.now()]);
  if (!result.rowCount) throw httpError(401, "本场游戏的登录已失效");
}
