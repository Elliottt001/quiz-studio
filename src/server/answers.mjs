import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { httpError } from "./auth.mjs";

export function reflectionPoints(raw) {
  if (typeof raw !== "string") return 0;
  const length = Array.from(raw.trim()).length;
  return length >= 5 && length <= 120 ? 10 : 0;
}

function validateAnswers(db, roundId, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw httpError(400, "答卷格式不正确");
  }
  const questions = db.prepare("SELECT id,kind FROM questions WHERE round_id=?").all(roundId);
  const byId = new Map(questions.map((question) => [question.id, question]));
  for (const [id, value] of Object.entries(answers)) {
    const question = byId.get(id);
    if (!question) throw httpError(400, "答卷包含未知题目");
    if (question.kind === "choice" && (!Number.isInteger(value) || value < 0 || value > 3)) {
      throw httpError(400, "单选题答案无效");
    }
    if (question.kind === "reflection" && (typeof value !== "string" || Array.from(value.trim()).length > 120)) {
      throw httpError(400, "感受回答不得超过120字");
    }
  }
  return JSON.stringify(answers);
}

function activeRound(db, roundId, now) {
  const round = db.prepare("SELECT status,deadline_at FROM rounds WHERE id=?").get(roundId);
  if (!round || round.status !== "open" || now >= round.deadline_at) {
    throw httpError(409, "本轮已截止");
  }
}

export function saveDraft(db, playerId, roundId, answers, now) {
  activeRound(db, roundId, now);
  const json = validateAnswers(db, roundId, answers);
  db.prepare(`INSERT INTO drafts(player_id,round_id,answers_json,saved_at) VALUES(?,?,?,?)
    ON CONFLICT(player_id,round_id) DO UPDATE SET answers_json=excluded.answers_json,saved_at=excluded.saved_at`)
    .run(playerId, roundId, json, now);
  return { savedAt: now };
}

export function submitAnswers(db, playerId, roundId, answers, requestKey, now) {
  if (typeof requestKey !== "string" || !requestKey || requestKey.length > 100) {
    throw httpError(400, "提交标识无效");
  }
  return transaction(db, () => {
    const prior = db.prepare(`SELECT id,revision,submitted_at,answers_json FROM submissions
      WHERE player_id=? AND round_id=? AND request_key=?`).get(playerId, roundId, requestKey);
    if (prior) {
      if (JSON.stringify(answers) !== prior.answers_json) throw httpError(409, "提交标识已用于不同答卷");
      return { id: prior.id, revision: prior.revision, submittedAt: prior.submitted_at };
    }
    activeRound(db, roundId, now);
    const json = validateAnswers(db, roundId, answers);
    const revision = db.prepare(`SELECT COALESCE(MAX(revision),0) AS current
      FROM submissions WHERE player_id=? AND round_id=?`).get(playerId, roundId).current + 1;
    const id = randomUUID();
    db.prepare(`INSERT INTO submissions
      (id,player_id,round_id,request_key,answers_json,revision,submitted_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, playerId, roundId, requestKey, json, revision, now);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("answer_submitted", playerId, String(roundId), now);
    return { id, revision, submittedAt: now };
  });
}

export function scoreRound(db, roundId) {
  const questions = db.prepare("SELECT id,kind,correct_option FROM questions WHERE round_id=?").all(roundId);
  const submissions = db.prepare(`SELECT player_id,answers_json FROM submissions
    WHERE round_id=? ORDER BY player_id,revision DESC`).all(roundId);
  const seen = new Set();
  const write = db.prepare(`INSERT INTO round_scores(player_id,round_id,points,answers_json)
    VALUES(?,?,?,?) ON CONFLICT(player_id,round_id)
    DO UPDATE SET points=excluded.points,answers_json=excluded.answers_json`);
  for (const submission of submissions) {
    if (seen.has(submission.player_id)) continue;
    seen.add(submission.player_id);
    const answers = JSON.parse(submission.answers_json);
    const detail = {};
    for (const question of questions) {
      const answer = answers[question.id];
      detail[question.id] = question.kind === "reflection"
        ? reflectionPoints(answer)
        : answer === question.correct_option ? 10 : 0;
    }
    const points = Object.values(detail).reduce((sum, value) => sum + value, 0);
    write.run(submission.player_id, roundId, points, JSON.stringify(detail));
  }
}
