import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool.mjs";
import { httpError } from "../http/errors.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publicGame = (row) => ({
  id: row.id, slug: row.slug, title: row.title, status: row.status, ownerId: row.owner_id
});

export async function createGame(pool, organizerId, input) {
  const slug = typeof input?.slug === "string" ? input.slug.trim() : "";
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!/^[a-z0-9-]{3,48}$/.test(slug) || !title || title.length > 120) {
    throw httpError(400, "游戏标识或名称无效");
  }
  try {
    return await withTransaction(pool, async (client) => {
      const row = (await client.query(`INSERT INTO games(id,slug,title,owner_id,created_at)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [randomUUID(), slug, title, organizerId, Date.now()])).rows[0];
      await client.query(`INSERT INTO game_members(game_id,organizer_id,role)
        VALUES($1,$2,'owner')`, [row.id, organizerId]);
      await client.query("INSERT INTO game_versions(game_id,version) VALUES($1,1)", [row.id]);
      await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
        VALUES($1,$2,'game_created',$3,$4)`, [row.id, organizerId, row.id, Date.now()]);
      return publicGame(row);
    });
  } catch (error) {
    if (error.code === "23505") throw httpError(409, "游戏标识已被使用");
    throw error;
  }
}

export async function getGameForMember(pool, gameId, organizerId) {
  if (!uuidPattern.test(gameId)) throw httpError(404, "游戏不存在");
  const row = (await pool.query(`SELECT g.* FROM games g JOIN game_members m
    ON m.game_id=g.id WHERE g.id=$1 AND m.organizer_id=$2`, [gameId, organizerId])).rows[0];
  if (!row) throw httpError(404, "游戏不存在");
  return publicGame(row);
}

export async function listGamesForMember(pool, organizerId) {
  const rows = (await pool.query(`SELECT g.* FROM games g JOIN game_members m
    ON m.game_id=g.id WHERE m.organizer_id=$1 ORDER BY g.created_at,g.id`, [organizerId])).rows;
  return rows.map(publicGame);
}

export async function requireGameRole(pool, gameId, organizerId, roles) {
  if (!uuidPattern.test(gameId)) throw httpError(404, "游戏不存在");
  const row = (await pool.query(`SELECT 1 FROM game_members
    WHERE game_id=$1 AND organizer_id=$2 AND role=ANY($3::text[])`,
  [gameId, organizerId, roles])).rows[0];
  if (!row) throw httpError(404, "游戏不存在");
}
