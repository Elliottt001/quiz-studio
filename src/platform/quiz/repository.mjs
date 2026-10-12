import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withTransaction } from "../db/pool.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { httpError } from "../http/errors.mjs";
import { scoreAnswer } from "./scoring.mjs";
import { validateAnswer } from "./rules.mjs";
import { bumpDraftVersion, publishFrozen } from "./editor.mjs";

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
    const game = (await client.query(`SELECT status,current_version FROM games
      WHERE id=$1 FOR UPDATE`, [gameId])).rows[0];
    if (game?.status !== "draft") throw httpError(409, "游戏发布后不能新增轮次");
    const count = (await client.query("SELECT count(*)::int AS n FROM rounds WHERE game_id=$1",
      [gameId])).rows[0].n;
    if (input.position !== count + 1) throw httpError(400, "轮次序号须连续");
    const row = (await client.query(`INSERT INTO rounds
      (game_id,id,position,title,duration_ms,config_version) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [gameId, randomUUID(), input.position, input.title.trim(), input.durationMs,
      game.current_version])).rows[0];
    for (const question of input.questions) {
      await client.query(`INSERT INTO questions
        (game_id,id,round_id,position,kind,prompt,options_json,correct_option,points,answer_rule_json)
        VALUES($1,$2,$3,$4,'choice',$5,$6::jsonb,$7,$8,$9::jsonb)`,
      [gameId, randomUUID(), row.id, question.position, question.prompt.trim(),
        JSON.stringify(question.options.map((option) => option.trim())),
        question.correctOption, question.points,
        JSON.stringify({ correctOption: question.correctOption })]);
    }
    await bumpDraftVersion(client, gameId, game.current_version, organizerId,
      "round_created", row.id, Date.now());
    return publicRound(row);
  });
}

export async function publishGame(pool, gameId, organizerId) {
  const published = await publishFrozen(pool, gameId, organizerId);
  return { id: published.gameId, status: published.status };
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
    correct_option,answer_rule_json,points FROM questions
    WHERE game_id=$1 AND round_id=$2 ORDER BY position`,
  [gameId, roundId])).rows.map((q) => ({
    id: q.id, position: q.position, kind: q.kind, prompt: q.prompt,
    points: q.points,
    ...(q.options_json ? { options: q.options_json } : {}),
    ...(q.kind === "length" ? { answerRule: q.answer_rule_json } : {}),
    ...(row.status === "published" && q.kind !== "length"
      ? { answerRule: q.answer_rule_json,
        ...(q.kind === "choice" ? { correctOption: q.correct_option } : {}) }
      : {})
  })) : [];
  return { round: publicRound(row), questions };
}

function mapQuestion(row) {
  return {
    id: row.id, kind: row.kind, points: row.points,
    ...(row.options_json ? { options: row.options_json } : {}),
    answerRule: row.answer_rule_json
  };
}

export async function validateRoundAnswers(client, gameId, roundId, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw httpError(400, "答卷格式无效");
  }
  const rows = (await client.query(`SELECT id,kind,options_json,answer_rule_json,points
    FROM questions WHERE game_id=$1 AND round_id=$2`,
  [gameId, roundId])).rows;
  const questions = new Map(rows.map((row) => [row.id, mapQuestion(row)]));
  for (const [id, value] of Object.entries(answers)) {
    const question = questions.get(id);
    if (!question) throw httpError(400, "答卷包含未知题目");
    validateAnswer(question, value);
  }
  return questions;
}

export async function submitAnswers(pool, { gameId, playerId, roundId, answers, requestKey, receivedAt }) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)
    || typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 100
    || !Number.isSafeInteger(receivedAt)) {
    throw httpError(400, "答卷或提交标识无效");
  }
  return withTransaction(pool, async (client) => {
    const player = await client.query("SELECT id FROM players WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [gameId, playerId]);
    if (!player.rowCount) throw httpError(401, "请加入本场游戏");
    const prior = (await client.query(`SELECT id,revision,submitted_at,answers_json FROM submissions
      WHERE game_id=$1 AND player_id=$2 AND round_id=$3 AND request_key=$4`,
    [gameId, playerId, roundId, requestKey])).rows[0];
    if (prior) {
      if (!isDeepStrictEqual(prior.answers_json, answers)) throw httpError(409, "提交标识冲突");
      return { id: prior.id, revision: prior.revision, submittedAt: Number(prior.submitted_at) };
    }
    const round = (await client.query("SELECT status,deadline_at FROM rounds WHERE game_id=$1 AND id=$2",
      [gameId, roundId])).rows[0];
    if (!round || !["open", "settling"].includes(round.status)
      || receivedAt >= Number(round.deadline_at)) throw httpError(409, "本轮已截止");
    await validateRoundAnswers(client, gameId, roundId, answers);
    const revision = (await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS next
      FROM submissions WHERE game_id=$1 AND player_id=$2 AND round_id=$3`,
    [gameId, playerId, roundId])).rows[0].next;
    const id = randomUUID();
    await client.query(`INSERT INTO submissions
      (game_id,id,player_id,round_id,request_key,answers_json,revision,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [gameId, id, playerId, roundId, requestKey, JSON.stringify(answers), revision, receivedAt]);
    return { id, revision, submittedAt: receivedAt };
  });
}

export async function settleDueRounds(pool, now, pendingFor = () => false) {
  const due = (await pool.query(`SELECT r.game_id,r.id,g.slug FROM rounds r JOIN games g ON g.id=r.game_id
    WHERE r.status IN ('open','settling') AND r.deadline_at<=$1
    ORDER BY r.game_id,r.position`, [now])).rows;
  const settled = [];
  for (const { game_id: gameId, id: roundId, slug } of due) {
    if (pendingFor(slug, roundId)) continue;
    const published = await withTransaction(pool, async (client) => {
      const round = (await client.query(`SELECT status,deadline_at FROM rounds
        WHERE game_id=$1 AND id=$2 FOR UPDATE SKIP LOCKED`, [gameId, roundId])).rows[0];
      if (!round || !["open", "settling"].includes(round.status)
        || Number(round.deadline_at) > now || pendingFor(slug, roundId)) return false;
      await client.query(`UPDATE rounds SET status='settling' WHERE game_id=$1 AND id=$2`,
        [gameId, roundId]);
      const questions = (await client.query(`SELECT id,kind,options_json,
        answer_rule_json,points FROM questions
        WHERE game_id=$1 AND round_id=$2 ORDER BY position`, [gameId, roundId])).rows;
      const latest = (await client.query(`SELECT DISTINCT ON (player_id) player_id,answers_json
        FROM submissions WHERE game_id=$1 AND round_id=$2 ORDER BY player_id,revision DESC`,
      [gameId, roundId])).rows;
      for (const submission of latest) {
        const detail = Object.fromEntries(questions.map((q) =>
          [q.id, scoreAnswer(mapQuestion(q), submission.answers_json[q.id])]));
        const points = Object.values(detail).reduce((total, value) => total + value, 0);
        await client.query(`INSERT INTO round_scores
          (game_id,player_id,round_id,points,detail_json) VALUES($1,$2,$3,$4,$5::jsonb)
          ON CONFLICT(game_id,player_id,round_id)
          DO UPDATE SET points=excluded.points,detail_json=excluded.detail_json`,
        [gameId, submission.player_id, roundId, points, JSON.stringify(detail)]);
      }
      await client.query(`UPDATE rounds SET status='published',published_at=$3
        WHERE game_id=$1 AND id=$2`, [gameId, roundId, now]);
      await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,occurred_at)
        VALUES($1,'system','round_published',$2,$3)`, [gameId, roundId, now]);
      return true;
    });
    if (published) settled.push(roundId);
  }
  return settled;
}
