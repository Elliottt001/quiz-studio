import { randomBytes } from "node:crypto";
import { withTransaction } from "../db/pool.mjs";
import { hashPassword } from "../auth/password.mjs";
import { newToken, tokenHash } from "../auth/sessions.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { httpError } from "../http/errors.mjs";

const lifetime = 10 * 60_000;
const playerLifetime = 30 * 24 * 60 * 60_000;

export async function issueRecovery(pool, gameId, playerId, actorId, now) {
  await requireGameRole(pool, gameId, actorId, ["owner", "operator"]);
  return withTransaction(pool, async (client) => {
    const player = (await client.query(`SELECT id FROM players
      WHERE game_id=$1 AND id=$2`, [gameId, playerId])).rows[0];
    if (!player) throw httpError(404, "本场玩家不存在");
    const recent = (await client.query(`SELECT count(*)::int AS n FROM recovery_codes
      WHERE game_id=$1 AND player_id=$2 AND expires_at>$3`,
    [gameId, playerId, now])).rows[0].n;
    if (recent >= 5) throw httpError(429, "恢复码申请过于频繁");
    const code = randomBytes(32).toString("base64url");
    await client.query(`INSERT INTO recovery_codes
      (code_hash,game_id,player_id,expires_at) VALUES($1,$2,$3,$4)`,
    [tokenHash(code), gameId, playerId, now + lifetime]);
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
      VALUES($1,$2,'recovery_issued',$3,$4)`, [gameId, actorId, playerId, now]);
    return code;
  });
}

export async function redeemRecovery(pool, gameId, code, password, now) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    throw httpError(409, "恢复码无效或过期");
  }
  const digest = tokenHash(code);
  const preliminary = (await pool.query(`SELECT 1 FROM recovery_codes
    WHERE game_id=$1 AND code_hash=$2 AND expires_at>$3 AND used_at IS NULL`,
  [gameId, digest, now])).rows[0];
  if (!preliminary) throw httpError(409, "恢复码无效或过期");
  const passwordHash = await hashPassword(password);
  return withTransaction(pool, async (client) => {
    const row = (await client.query(`SELECT player_id FROM recovery_codes
      WHERE game_id=$1 AND code_hash=$2 AND expires_at>$3 AND used_at IS NULL
      FOR UPDATE`, [gameId, digest, now])).rows[0];
    if (!row) throw httpError(409, "恢复码无效或过期");
    const player = (await client.query(`UPDATE players SET password_hash=$3
      WHERE game_id=$1 AND id=$2 RETURNING login_code`,
    [gameId, row.player_id, passwordHash])).rows[0];
    await client.query(`UPDATE player_sessions SET revoked_at=$3
      WHERE game_id=$1 AND player_id=$2 AND revoked_at IS NULL`,
    [gameId, row.player_id, now]);
    await client.query(`UPDATE recovery_codes SET used_at=$3
      WHERE game_id=$1 AND code_hash=$2`, [gameId, digest, now]);
    const sessionToken = newToken();
    await client.query(`INSERT INTO player_sessions
      (token_hash,game_id,player_id,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5)`,
    [tokenHash(sessionToken), gameId, row.player_id, now, now + playerLifetime]);
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
      VALUES($1,$2,'recovery_redeemed',$2,$3)`, [gameId, row.player_id, now]);
    return {
      playerId: row.player_id, sessionToken, loginCode: player.login_code
    };
  });
}
