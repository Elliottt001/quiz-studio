import { randomInt, randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { httpError } from "./auth.mjs";
import { getFreeze } from "./standings.mjs";

const tierOrder = { third: 0, second: 1, grand: 2 };

export function configurePrizes(db, prizes, adminId, now) {
  if (!Array.isArray(prizes) || !prizes.length || new Set(prizes.map((p) => p.id)).size !== prizes.length
    || prizes.some((p) => typeof p.id !== "string" || !p.id || !tierOrder.hasOwnProperty(p.tier)
      || typeof p.title !== "string" || !p.title.trim()
      || !Number.isInteger(p.position) || p.position < 1)) {
    throw httpError(400, "奖品配置无效");
  }
  return transaction(db, () => {
    if (getFreeze(db) || db.prepare("SELECT 1 FROM draws LIMIT 1").get()) {
      throw httpError(409, "冻结或抽取后不能改奖品");
    }
    db.exec("DELETE FROM prizes");
    const insert = db.prepare("INSERT INTO prizes(id,tier,title,position) VALUES(?,?,?,?)");
    for (const prize of prizes) insert.run(prize.id, prize.tier, prize.title.trim(), prize.position);
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("prizes_configured", adminId, "all", now);
    return { count: prizes.length };
  });
}

export function getDraw(db, id) {
  const row = db.prepare(`SELECT id,prize_id,player_id,freeze_id,total_balls_before,
    selected_index,selected_ball_id,drawn_at,status,refusal_reason FROM draws WHERE id=?`).get(id);
  return row && {
    id: row.id, prizeId: row.prize_id, playerId: row.player_id, freezeId: row.freeze_id,
    totalBallsBefore: row.total_balls_before, selectedIndex: row.selected_index,
    selectedBallId: row.selected_ball_id, drawnAt: row.drawn_at,
    status: row.status, refusalReason: row.refusal_reason
  };
}

export function listDraws(db) {
  return db.prepare("SELECT id FROM draws ORDER BY drawn_at,id").all().map(({ id }) => getDraw(db, id));
}

export function drawWinner(db, prizeId, requestKey, randomIndex = randomInt, now = Date.now()) {
  if (typeof requestKey !== "string" || !requestKey || requestKey.length > 100) {
    throw httpError(400, "抽取标识无效");
  }
  return transaction(db, () => {
    const prior = db.prepare("SELECT id,prize_id FROM draws WHERE request_key=?").get(requestKey);
    if (prior) {
      if (prior.prize_id !== prizeId) throw httpError(409, "抽取标识已用于其他奖品");
      return getDraw(db, prior.id);
    }
    const pool = getFreeze(db);
    if (!pool) throw httpError(409, "最终奖池尚未冻结");
    const prize = db.prepare("SELECT id,tier,position FROM prizes WHERE id=?").get(prizeId);
    if (!prize) throw httpError(404, "奖品不存在");
    const pending = db.prepare(`SELECT 1 FROM draws WHERE prize_id=? AND status IN ('pending','claimed')`)
      .get(prizeId);
    if (pending) throw httpError(409, "此奖品已经抽出");
    const ordered = db.prepare("SELECT id,tier,position FROM prizes").all()
      .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.position - b.position || a.id.localeCompare(b.id));
    for (const earlier of ordered) {
      if (earlier.id === prizeId) break;
      if (!db.prepare("SELECT 1 FROM draws WHERE prize_id=? AND status IN ('pending','claimed')").get(earlier.id)) {
        throw httpError(409, "请按三等奖、二等奖、大奖的顺序抽取");
      }
    }
    const used = new Set(db.prepare("SELECT player_id FROM draws").all().map((row) => row.player_id));
    const remaining = pool.entries.filter((entry) => !used.has(entry.playerId))
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
    const totalBallsBefore = remaining.reduce((sum, entry) => sum + entry.balls, 0);
    if (totalBallsBefore < 1) throw httpError(409, "奖池人数不足");
    const selectedIndex = randomIndex(totalBallsBefore);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= totalBallsBefore) {
      throw httpError(500, "随机索引超出奖池");
    }
    let offset = selectedIndex;
    for (const entry of remaining) {
      if (offset < entry.balls) {
        const id = randomUUID();
        const selectedBallId = `${entry.playerId}:${offset + 1}`;
        db.prepare(`INSERT INTO draws
          (id,prize_id,request_key,player_id,freeze_id,total_balls_before,
           selected_index,selected_ball_id,drawn_at)
          VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(id, prizeId, requestKey, entry.playerId, pool.id, totalBallsBefore,
            selectedIndex, selectedBallId, now);
        db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
          .run("prize_drawn", "admin", id, now);
        return getDraw(db, id);
      }
      offset -= entry.balls;
    }
    throw httpError(500, "奖池映射失败");
  });
}

export function refusePrize(db, drawId, reason, adminId, now = Date.now()) {
  return transaction(db, () => {
    if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "请填写放弃原因");
    const result = db.prepare(`UPDATE draws SET status='refused',refusal_reason=?
      WHERE id=? AND status='pending'`).run(reason.trim(), drawId);
    if (!result.changes) throw httpError(409, "该中奖记录不能放弃");
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("prize_refused", adminId, drawId, now);
    return getDraw(db, drawId);
  });
}

export function confirmPrize(db, drawId, adminId, now = Date.now()) {
  return transaction(db, () => {
    const result = db.prepare("UPDATE draws SET status='claimed' WHERE id=? AND status='pending'").run(drawId);
    if (!result.changes) throw httpError(409, "该奖品不能重复领取");
    db.prepare("INSERT INTO audit_events(kind,actor_id,target_id,occurred_at) VALUES(?,?,?,?)")
      .run("prize_claimed", adminId, drawId, now);
    return getDraw(db, drawId);
  });
}
