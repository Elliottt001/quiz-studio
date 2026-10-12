import { withTransaction } from "../db/pool.mjs";
import { httpError } from "../http/errors.mjs";
import { validateRoundAnswers } from "../quiz/repository.mjs";

export async function saveDraft(pool, { gameId, playerId, roundId, answers, receivedAt }) {
  if (!Number.isSafeInteger(receivedAt)) throw httpError(400, "草稿时间无效");
  return withTransaction(pool, async (client) => {
    const player = await client.query("SELECT 1 FROM players WHERE game_id=$1 AND id=$2",
      [gameId, playerId]);
    if (!player.rowCount) throw httpError(401, "请加入本场游戏");
    const round = (await client.query(`SELECT status,deadline_at FROM rounds
      WHERE game_id=$1 AND id=$2`, [gameId, roundId])).rows[0];
    if (round?.status !== "open" || receivedAt >= Number(round.deadline_at)) {
      throw httpError(409, "本轮已截止");
    }
    await validateRoundAnswers(client, gameId, roundId, answers);
    const saved = await client.query(`INSERT INTO drafts
      (game_id,player_id,round_id,answers_json,saved_at)
      VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(game_id,player_id,round_id)
      DO UPDATE SET answers_json=excluded.answers_json,saved_at=excluded.saved_at
      WHERE drafts.saved_at<=excluded.saved_at RETURNING saved_at`,
    [gameId, playerId, roundId, JSON.stringify(answers), receivedAt]);
    if (saved.rowCount) return { savedAt: Number(saved.rows[0].saved_at) };
    const prior = (await client.query(`SELECT saved_at FROM drafts
      WHERE game_id=$1 AND player_id=$2 AND round_id=$3`,
    [gameId, playerId, roundId])).rows[0];
    return { savedAt: Number(prior.saved_at) };
  });
}
