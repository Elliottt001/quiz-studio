import { withTransaction } from "../db/pool.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { httpError } from "../http/errors.mjs";
import { scoreAnswer } from "./scoring.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function rescoreRound(client, gameId, roundId) {
  const questions = (await client.query(`SELECT q.id,q.kind,q.options_json,q.answer_rule_json,
    q.points,v.question_id AS voided FROM questions q
    LEFT JOIN voided_questions v ON v.game_id=q.game_id AND v.question_id=q.id
    WHERE q.game_id=$1 AND q.round_id=$2 ORDER BY q.position`, [gameId, roundId])).rows;
  const latest = (await client.query(`SELECT DISTINCT ON (player_id) player_id,answers_json
    FROM submissions WHERE game_id=$1 AND round_id=$2 ORDER BY player_id,revision DESC`,
  [gameId, roundId])).rows;
  for (const submission of latest) {
    const detail = Object.fromEntries(questions.map((question) => [
      question.id,
      scoreAnswer({
        kind: question.kind, points: question.points,
        ...(question.options_json ? { options: question.options_json } : {}),
        answerRule: question.answer_rule_json
      }, submission.answers_json[question.id], !!question.voided)
    ]));
    const points = Object.values(detail).reduce((total, value) => total + value, 0);
    await client.query(`INSERT INTO round_scores
      (game_id,player_id,round_id,points,detail_json) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(game_id,player_id,round_id)
      DO UPDATE SET points=excluded.points,detail_json=excluded.detail_json`,
    [gameId, submission.player_id, roundId, points, JSON.stringify(detail)]);
  }
}

export async function voidQuestion(pool, gameId, questionId, ownerId, reason, now) {
  await requireGameRole(pool, gameId, ownerId, ["owner"]);
  if (!uuid.test(questionId)) throw httpError(404, "题目不存在");
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500) {
    throw httpError(400, "请填写 1–500 字的作废原因");
  }
  return withTransaction(pool, async (client) => {
    const question = (await client.query(`SELECT q.round_id,r.status FROM questions q
      JOIN rounds r ON r.game_id=q.game_id AND r.id=q.round_id
      WHERE q.game_id=$1 AND q.id=$2 FOR UPDATE OF r`,
    [gameId, questionId])).rows[0];
    if (!question) throw httpError(404, "题目不存在");
    if (question.status !== "published") throw httpError(409, "请等待本轮结算公布");
    const inserted = await client.query(`INSERT INTO voided_questions
      (game_id,question_id,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(game_id,question_id) DO NOTHING RETURNING question_id`,
    [gameId, questionId, reason.trim(), ownerId, now]);
    if (!inserted.rowCount) throw httpError(409, "该题已作废");
    await rescoreRound(client, gameId, question.round_id);
    await client.query(`INSERT INTO audit_events
      (game_id,actor_id,kind,target_id,details_json,occurred_at)
      VALUES($1,$2,'question_voided',$3,$4::jsonb,$5)`,
    [gameId, ownerId, questionId,
      JSON.stringify({ reason: reason.trim(), roundId: question.round_id }), now]);
    return { questionId, roundId: question.round_id };
  });
}
