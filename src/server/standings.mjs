import { createHash, randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { httpError } from "./auth.mjs";
import { scoreRound } from "./answers.mjs";

function ensureMutable(db) {
  if (db.prepare("SELECT id FROM freeze_snapshots LIMIT 1").get()) {
    throw httpError(409, "奖池已冻结");
  }
}

export function ticketCount(totalScore) {
  if (!Number.isInteger(totalScore) || totalScore < 0 || totalScore > 320 || totalScore % 10 !== 0) {
    throw httpError(400, "总分无效");
  }
  return 10 + totalScore / 10;
}

export function addBonus(db, playerId, kind, points, reason, adminId, now) {
  return transaction(db, () => {
    ensureMutable(db);
    if (!db.prepare("SELECT id FROM players WHERE id=?").get(playerId)) throw httpError(404, "玩家不存在");
    if (!["speaking", "work"].includes(kind) || points !== 10 || typeof reason !== "string" || !reason.trim()) {
      throw httpError(400, "额外积分记录无效");
    }
    if (kind === "work" && db.prepare(`SELECT 1 FROM bonus_events
      WHERE player_id=? AND kind='work' AND voided_at IS NULL`).get(playerId)) {
      throw httpError(409, "工作分每人只记一次");
    }
    if (db.prepare(`SELECT 1 FROM bonus_events WHERE player_id=? AND kind=? AND reason=? AND voided_at IS NULL`)
      .get(playerId, kind, reason.trim())) throw httpError(409, "此项加分已登记");
    const current = db.prepare(`SELECT COALESCE(SUM(points),0) AS points FROM bonus_events
      WHERE player_id=? AND voided_at IS NULL`).get(playerId).points;
    if (current + points > 20) throw httpError(409, "额外积分不能超过20分");
    const id = randomUUID();
    db.prepare(`INSERT INTO bonus_events(id,player_id,kind,points,reason,actor_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, playerId, kind, points, reason.trim(), adminId, now);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("bonus_added", adminId, playerId, now);
    return { id, playerId, kind, points, reason: reason.trim() };
  });
}

export function voidBonus(db, bonusId, reason, adminId, now) {
  return transaction(db, () => {
    ensureMutable(db);
    if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "请填写撤销原因");
    const row = db.prepare("SELECT id,player_id,voided_at FROM bonus_events WHERE id=?").get(bonusId);
    if (!row) throw httpError(404, "加分记录不存在");
    if (row.voided_at !== null) throw httpError(409, "该加分已撤销");
    db.prepare("UPDATE bonus_events SET voided_at=? WHERE id=?").run(now, bonusId);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,details_json,occurred_at) VALUES(?,?,?,?,?)")
      .run("bonus_voided", adminId, bonusId, JSON.stringify({ playerId: row.player_id, reason: reason.trim() }), now);
    return { id: bonusId, playerId: row.player_id, voidedAt: now };
  });
}

export function markAttendance(db, playerId, adminId, now) {
  ensureMutable(db);
  const result = db.prepare("UPDATE eligibility SET checked_in=1,updated_at=? WHERE player_id=?")
    .run(now, playerId);
  if (!result.changes) throw httpError(404, "玩家不存在");
  db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
    .run("attendance_confirmed", adminId, playerId, now);
}

export function grantWorkOverride(db, playerId, reason, adminId, now) {
  ensureMutable(db);
  if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "请填写工作资格依据");
  const result = db.prepare(`UPDATE eligibility SET checked_in=1,eligible_override=1,reason=?,updated_at=?
    WHERE player_id=?`).run(reason.trim(), now, playerId);
  if (!result.changes) throw httpError(404, "玩家不存在");
  db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,details_json,occurred_at) VALUES(?,?,?,?,?)")
    .run("work_override", adminId, playerId, JSON.stringify({ reason: reason.trim() }), now);
}

export function excludePlayer(db, playerId, reason, adminId, now = Date.now()) {
  ensureMutable(db);
  if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "请填写排除原因");
  const result = db.prepare("UPDATE eligibility SET excluded=1,reason=?,updated_at=? WHERE player_id=?")
    .run(reason.trim(), now, playerId);
  if (!result.changes) throw httpError(404, "玩家不存在");
  db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
    .run("player_excluded", adminId, playerId, now);
}

export function voidQuestion(db, questionId, reason, adminId, now = Date.now()) {
  return transaction(db, () => {
    ensureMutable(db);
    if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "请填写作废原因");
    const question = db.prepare("SELECT round_id FROM questions WHERE id=?").get(questionId);
    if (!question) throw httpError(404, "题目不存在");
    db.prepare(`INSERT INTO voided_questions(question_id,reason,actor_id,created_at) VALUES(?,?,?,?)`)
      .run(questionId, reason.trim(), adminId, now);
    scoreRound(db, question.round_id);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("question_voided", adminId, questionId, now);
  });
}

export function listStandings(db) {
  const rows = db.prepare(`SELECT p.id,p.real_name,p.nickname,p.grade,p.team,
    COALESCE((SELECT SUM(s.points) FROM round_scores s
      JOIN rounds r ON r.id=s.round_id WHERE s.player_id=p.id AND r.status='published'),0)
    + COALESCE((SELECT SUM(b.points) FROM bonus_events b
      WHERE b.player_id=p.id AND b.voided_at IS NULL),0) AS score
    FROM players p ORDER BY score DESC,p.id ASC`).all();
  let previous = null;
  let rank = 0;
  return rows.map((row, index) => {
    if (row.score !== previous) rank = index + 1;
    previous = row.score;
    return {
      id: row.id, realName: row.real_name, nickname: row.nickname,
      grade: row.grade, team: row.team, score: row.score, rank
    };
  });
}

export function getFreeze(db) {
  const row = db.prepare("SELECT id,created_at,entries_json,hash FROM freeze_snapshots LIMIT 1").get();
  return row && {
    id: row.id, createdAt: row.created_at,
    entries: JSON.parse(row.entries_json), hash: row.hash
  };
}

export function freezePool(db, adminId, now = Date.now()) {
  return transaction(db, () => {
    if (getFreeze(db)) return getFreeze(db);
    const unfinished = db.prepare(`SELECT COUNT(*) AS count FROM rounds
      WHERE status NOT IN ('published','voided')`).get().count;
    if (unfinished) throw httpError(409, "尚有未结束的轮次");
    const standing = new Map(listStandings(db).map((row) => [row.id, row]));
    const invalidQuiz = db.prepare(`SELECT COUNT(*) AS count FROM round_scores s
      JOIN rounds r ON r.id=s.round_id WHERE r.status='published'`).get().count === 0;
    const eligible = db.prepare(`SELECT p.id FROM players p JOIN eligibility e ON e.player_id=p.id
      WHERE e.excluded=0 AND (
        ?=1
        OR EXISTS(SELECT 1 FROM submissions s WHERE s.player_id=p.id)
        OR (e.checked_in=1 AND e.eligible_override=1)
      ) ORDER BY p.id`).all(invalidQuiz ? 1 : 0);
    if (!eligible.length) throw httpError(409, "没有合资格的抽奖参与者");
    const prizeCount = db.prepare("SELECT COUNT(*) AS count FROM prizes").get().count;
    if (!prizeCount) throw httpError(409, "请先配置抽奖奖品");
    if (prizeCount > eligible.length) throw httpError(409, "奖品数量超过合资格人数");
    const entries = eligible.map(({ id }) => {
      const row = standing.get(id);
      return {
        playerId: id, realName: row.realName, nickname: row.nickname,
        score: row.score, balls: invalidQuiz ? 1 : ticketCount(row.score)
      };
    });
    const id = randomUUID();
    const json = JSON.stringify(entries);
    const hash = createHash("sha256").update(json).digest("hex");
    db.prepare("INSERT INTO freeze_snapshots(id,created_at,entries_json,hash) VALUES(?,?,?,?)")
      .run(id, now, json, hash);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("pool_frozen", adminId, id, now);
    return { id, createdAt: now, entries, hash };
  });
}
