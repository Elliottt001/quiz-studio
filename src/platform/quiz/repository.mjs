import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { httpError } from "../http/errors.mjs";

function publicRound(row) {
  return {
    id: row.id,
    gameId: row.game_id,
    position: row.position,
    title: row.title,
    durationMs: row.duration_ms,
    status: row.status,
    startedAt: row.started_at === null ? null : Number(row.started_at),
    deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at)
  };
}

function validateRound(input) {
  if (!input || !Number.isInteger(input.position) || input.position < 1
    || typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 120
    || !Number.isInteger(input.durationMs) || input.durationMs < 30_000
    || input.durationMs > 3_600_000
    || !Array.isArray(input.questions) || input.questions.length < 1
    || input.questions.length > 100) {
    throw httpError(400, "轮次配置无效");
  }
  for (const [index, q] of input.questions.entries()) {
    if (q?.position !== index + 1 || q.kind !== "choice"
      || typeof q.prompt !== "string" || !q.prompt.trim() || q.prompt.length > 500
      || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6
      || q.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 200)
      || !Number.isInteger(q.correctOption) || q.correctOption < 0
      || q.correctOption >= q.options.length
      || !Number.isInteger(q.points) || q.points < 0 || q.points > 10_000) {
      throw httpError(400, "题目配置无效");
    }
  }
}

export async function createRound(pool, gameId, organizerId, input) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  validateRound(input);
  return withTransaction(pool, async (client) => {
    const game = (await client.query("SELECT status FROM games WHERE id=$1 FOR UPDATE", [gameId])).rows[0];
    if (game?.status !== "draft") throw httpError(409, "游戏发布后不能新增轮次");
    const count = (await client.query("SELECT count(*)::int AS n FROM rounds WHERE game_id=$1",
      [gameId])).rows[0].n;
    if (input.position !== count + 1) throw httpError(400, "轮次序号须连续");
    const row = (await client.query(`INSERT INTO rounds
      (game_id,id,position,title,duration_ms,config_version) VALUES($1,$2,$3,$4,$5,1) RETURNING *`,
    [gameId, randomUUID(), input.position, input.title.trim(), input.durationMs])).rows[0];
    for (const question of input.questions) {
      await client.query(`INSERT INTO questions
        (game_id,id,round_id,position,kind,prompt,options_json,correct_option,points)
        VALUES($1,$2,$3,$4,'choice',$5,$6::jsonb,$7,$8)`,
      [gameId, randomUUID(), row.id, question.position, question.prompt.trim(),
        JSON.stringify(question.options.map((option) => option.trim())),
        question.correctOption, question.points]);
    }
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
      VALUES($1,$2,'round_created',$3,$4)`, [gameId, organizerId, row.id, Date.now()]);
    return publicRound(row);
  });
}

export async function publishGame(pool, gameId, organizerId) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  return withTransaction(pool, async (client) => {
    const game = (await client.query("SELECT * FROM games WHERE id=$1 FOR UPDATE", [gameId])).rows[0];
    if (game?.status !== "draft") throw httpError(409, "游戏已发布");
    const count = (await client.query("SELECT count(*)::int AS n FROM rounds WHERE game_id=$1",
      [gameId])).rows[0].n;
    if (!count) throw httpError(409, "至少配置一个完整轮次");
    await client.query("UPDATE games SET status='published' WHERE id=$1", [gameId]);
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
      VALUES($1,$2,'game_published',$3,$4)`, [gameId, organizerId, gameId, Date.now()]);
    return { id: gameId, status: "published" };
  });
}

export async function startRound(pool, gameId, roundId, organizerId, now) {
  await requireGameRole(pool, gameId, organizerId, ["owner", "operator"]);
  return withTransaction(pool, async (client) => {
    const game = (await client.query("SELECT status FROM games WHERE id=$1 FOR UPDATE", [gameId])).rows[0];
    if (game?.status !== "published") throw httpError(409, "游戏尚未发布");
    const row = (await client.query("SELECT position,status FROM rounds WHERE game_id=$1 AND id=$2",
      [gameId, roundId])).rows[0];
    if (!row) throw httpError(404, "轮次不存在");
    if (row.status !== "prepared") throw httpError(409, "本轮已开始");
    const unfinished = (await client.query(`SELECT count(*)::int AS n FROM rounds
      WHERE game_id=$1 AND position<$2 AND status NOT IN ('published','voided')`,
    [gameId, row.position])).rows[0].n;
    if (unfinished) throw httpError(409, "前面的轮次尚未结算");
    const open = (await client.query(`SELECT 1 FROM rounds WHERE game_id=$1 AND status='open'`,
      [gameId])).rowCount;
    if (open) throw httpError(409, "当前仍有进行中的轮次");
    const started = (await client.query(`UPDATE rounds SET status='open',started_at=$3::bigint,
      deadline_at=$3::bigint+duration_ms WHERE game_id=$1 AND id=$2 AND status='prepared' RETURNING *`,
    [gameId, roundId, now])).rows[0];
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
      VALUES($1,$2,'round_started',$3,$4)`, [gameId, organizerId, roundId, now]);
    return publicRound(started);
  });
}

export async function getPublicRound(pool, gameId, roundId) {
  const row = (await pool.query("SELECT * FROM rounds WHERE game_id=$1 AND id=$2",
    [gameId, roundId])).rows[0];
  if (!row) throw httpError(404, "轮次不存在");
  const visible = ["open", "published"].includes(row.status);
  const questions = visible ? (await pool.query(`SELECT id,position,kind,prompt,options_json,
    correct_option,points FROM questions WHERE game_id=$1 AND round_id=$2 ORDER BY position`,
  [gameId, roundId])).rows.map((q) => ({
    id: q.id, position: q.position, kind: q.kind, prompt: q.prompt, options: q.options_json,
    points: q.points, ...(row.status === "published" ? { correctOption: q.correct_option } : {})
  })) : [];
  return { round: publicRound(row), questions };
}
