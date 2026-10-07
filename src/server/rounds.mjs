import { transaction } from "./db.mjs";
import { httpError } from "./auth.mjs";

const expectedCounts = [6, 10, 9, 5];

export function importQuestionBank(db, questions, adminId, now) {
  if (!Array.isArray(questions) || questions.length !== 30) {
    throw httpError(400, "正式题库必须有30题");
  }
  const ids = new Set();
  for (const [roundIndex, count] of expectedCounts.entries()) {
    const group = questions.filter((q) => q.roundId === roundIndex + 1);
    if (group.length !== count) throw httpError(400, `第${roundIndex + 1}轮题数不正确`);
    for (let position = 1; position <= count; position++) {
      const q = group.find((candidate) => candidate.position === position);
      const reflection = roundIndex === 3 && position === 5;
      if (!q || typeof q.id !== "string" || ids.has(q.id)
        || typeof q.prompt !== "string" || !q.prompt.trim()
        || q.kind !== (reflection ? "reflection" : "choice")) {
        throw httpError(400, "题库顺序或题型不正确");
      }
      ids.add(q.id);
      if (!reflection && (!Array.isArray(q.options) || q.options.length !== 4
        || q.options.some((option) => typeof option !== "string" || !option.trim())
        || !Number.isInteger(q.correctOption) || q.correctOption < 0 || q.correctOption > 3)) {
        throw httpError(400, "单选题必须有四个选项和一个正确答案");
      }
    }
  }
  return transaction(db, () => {
    const started = db.prepare("SELECT COUNT(*) AS count FROM rounds WHERE status!='prepared'").get().count;
    if (started) throw httpError(409, "轮次开始后不能替换正式题库");
    db.exec("DELETE FROM questions");
    const insert = db.prepare(`INSERT INTO questions
      (id,round_id,position,kind,prompt,options_json,correct_option,explanation,source)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const q of questions) {
      insert.run(q.id, q.roundId, q.position, q.kind, q.prompt.trim(),
        q.kind === "choice" ? JSON.stringify(q.options) : null,
        q.kind === "choice" ? q.correctOption : null,
        q.explanation ?? "", q.source ?? "");
    }
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("questions_imported", adminId, "all", now);
    return { count: questions.length };
  });
}

export function getRoundState(db, id) {
  const row = db.prepare("SELECT id,title,status,started_at,deadline_at,published_at FROM rounds WHERE id=?").get(id);
  if (!row) throw httpError(404, "轮次不存在");
  return {
    id: row.id, title: row.title, status: row.status,
    startedAt: row.started_at, deadlineAt: row.deadline_at, publishedAt: row.published_at
  };
}

export function startRound(db, id, adminId, now) {
  return transaction(db, () => {
    const row = db.prepare("SELECT status FROM rounds WHERE id=?").get(id);
    if (!row) throw httpError(404, "轮次不存在");
    if (row.status !== "prepared") throw httpError(409, "本轮已开始");
    const count = db.prepare("SELECT COUNT(*) AS count FROM questions WHERE round_id=?").get(id).count;
    if (count !== expectedCounts[id - 1]) throw httpError(409, "题库尚未准备完成");
    if (id > 1) {
      const previous = db.prepare("SELECT status FROM rounds WHERE id=?").get(id - 1).status;
      if (!["published", "voided"].includes(previous)) throw httpError(409, "上一轮尚未结束");
    }
    db.prepare("UPDATE rounds SET status='open',started_at=?,deadline_at=?,started_by=? WHERE id=?")
      .run(now, now + 300_000, adminId, id);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("round_started", adminId, String(id), now);
    return getRoundState(db, id);
  });
}

export function settleDueRounds(db, now, scorer = () => {}) {
  const due = db.prepare(`SELECT id FROM rounds
    WHERE status IN ('open','settling') AND deadline_at <= ? ORDER BY id`).all(now);
  for (const { id } of due) {
    transaction(db, () => {
      db.prepare("UPDATE rounds SET status='settling' WHERE id=?").run(id);
      scorer(db, id);
      db.prepare("UPDATE rounds SET status='published',published_at=? WHERE id=?").run(now, id);
      db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
        .run("round_published", "system", String(id), now);
    });
  }
  return due.map((row) => row.id);
}

export function publicRound(db) {
  const row = db.prepare(`SELECT id FROM rounds WHERE status='open' ORDER BY id LIMIT 1`).get()
    ?? db.prepare(`SELECT id FROM rounds WHERE status='prepared' ORDER BY id LIMIT 1`).get()
    ?? db.prepare(`SELECT id FROM rounds ORDER BY id DESC LIMIT 1`).get();
  return getRoundState(db, row.id);
}

export function publicQuestions(db, roundId) {
  const status = getRoundState(db, roundId).status;
  if (!["open", "published"].includes(status)) return [];
  return db.prepare(`SELECT id,position,kind,prompt,options_json,correct_option,explanation
    FROM questions WHERE round_id=? ORDER BY position`).all(roundId).map((row) => ({
    id: row.id,
    position: row.position,
    kind: row.kind,
    prompt: row.prompt,
    ...(row.kind === "choice" ? { options: JSON.parse(row.options_json) } : {}),
    ...(status === "published" ? {
      correctOption: row.correct_option,
      explanation: row.explanation
    } : {})
  }));
}

export function voidRound(db, id, reason, adminId, now = Date.now()) {
  return transaction(db, () => {
    if (db.prepare("SELECT 1 FROM freeze_snapshots LIMIT 1").get()) {
      throw httpError(409, "奖池冻结后不能作废轮次");
    }
    if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "请填写作废原因");
    const result = db.prepare("UPDATE rounds SET status='voided' WHERE id=? AND status IN ('open','published')")
      .run(id);
    if (!result.changes) throw httpError(409, "本轮不能作废");
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,details_json,occurred_at) VALUES(?,?,?,?,?)")
      .run("round_voided", adminId, String(id), JSON.stringify({ reason: reason.trim() }), now);
    return getRoundState(db, id);
  });
}
