import { withTransaction } from "../db/pool.mjs";
import { requireGameRole } from "./repository.mjs";
import { httpError } from "../http/errors.mjs";

export async function inviteOperator(pool, gameId, ownerId, login, now) {
  await requireGameRole(pool, gameId, ownerId, ["owner"]);
  const normalized = typeof login === "string" ? login.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{3,32}$/.test(normalized)) {
    throw httpError(400, "组织者登录名无效");
  }
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM games WHERE id=$1 FOR UPDATE", [gameId]);
    const target = (await client.query("SELECT id,login FROM organizers WHERE login=$1",
      [normalized])).rows[0];
    if (!target) throw httpError(404, "组织者账号不存在");
    const existing = (await client.query(`SELECT role FROM game_members
      WHERE game_id=$1 AND organizer_id=$2`, [gameId, target.id])).rows[0];
    if (existing?.role === "owner") throw httpError(409, "不能将游戏 owner 改为操作员");
    if (!existing) {
      await client.query(`INSERT INTO game_members(game_id,organizer_id,role)
        VALUES($1,$2,'operator')`, [gameId, target.id]);
      await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,
        occurred_at) VALUES($1,$2,'operator_invited',$3,$4)`,
      [gameId, ownerId, target.id, now]);
    }
    return {
      gameId, organizerId: target.id, login: target.login, role: "operator"
    };
  });
}

export async function removeOperator(pool, gameId, ownerId, organizerId, now) {
  await requireGameRole(pool, gameId, ownerId, ["owner"]);
  return withTransaction(pool, async (client) => {
    await client.query("SELECT id FROM games WHERE id=$1 FOR UPDATE", [gameId]);
    const member = (await client.query(`SELECT role FROM game_members
      WHERE game_id=$1 AND organizer_id=$2`, [gameId, organizerId])).rows[0];
    if (!member) throw httpError(404, "操作员不存在");
    if (member.role === "owner") throw httpError(409, "不能移除游戏 owner");
    await client.query(`DELETE FROM game_members WHERE game_id=$1
      AND organizer_id=$2 AND role='operator'`, [gameId, organizerId]);
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,
      occurred_at) VALUES($1,$2,'operator_removed',$3,$4)`,
    [gameId, ownerId, organizerId, now]);
  });
}
