import { requireAdmin } from "../auth.mjs";
import {
  addBonus, voidBonus, markAttendance, grantWorkOverride, excludePlayer, voidQuestion,
  listStandings, freezePool, getFreeze
} from "../standings.mjs";

export function registerStandingsRoutes(app) {
  app.route("GET", /^\/api\/standings$/, ({ db }) => ({ body: { players: listStandings(db) } }));
  app.route("GET", /^\/api\/pool$/, ({ db }) => ({ body: { pool: getFreeze(db) } }));
  app.route("GET", /^\/api\/admin\/export$/, (ctx) => {
    requireAdmin(ctx);
    const tables = {
      players: "SELECT id,real_name,nickname,grade,team,created_at FROM players ORDER BY id",
      rounds: "SELECT * FROM rounds ORDER BY id",
      questions: "SELECT * FROM questions ORDER BY round_id,position",
      submissions: "SELECT * FROM submissions ORDER BY player_id,round_id,revision",
      scores: "SELECT * FROM round_scores ORDER BY player_id,round_id",
      bonus: "SELECT * FROM bonus_events ORDER BY created_at,id",
      eligibility: "SELECT * FROM eligibility ORDER BY player_id",
      frozen: "SELECT * FROM freeze_snapshots ORDER BY created_at,id",
      prizes: "SELECT * FROM prizes ORDER BY tier,position,id",
      draws: "SELECT * FROM draws ORDER BY drawn_at,id",
      audit: "SELECT * FROM audit_events ORDER BY id"
    };
    const body = Object.fromEntries(Object.entries(tables)
      .map(([key, query]) => [key, ctx.db.prepare(query).all()]));
    body.exportedAt = ctx.clock();
    return { headers: { "cache-control": "no-store" }, body };
  });
  app.route("GET", /^\/api\/admin\/players$/, (ctx) => {
    requireAdmin(ctx);
    const scoreById = new Map(listStandings(ctx.db).map((player) => [player.id, player]));
    const rows = ctx.db.prepare(`SELECT p.id,p.real_name,p.nickname,p.grade,p.team,
      e.checked_in,e.eligible_override,e.excluded,e.reason,
      (SELECT COUNT(*) FROM players another WHERE another.real_name=p.real_name
        AND another.grade=p.grade AND another.team=p.team) AS same_identity_count,
      EXISTS(SELECT 1 FROM submissions s WHERE s.player_id=p.id) AS submitted
      FROM players p JOIN eligibility e ON e.player_id=p.id ORDER BY p.created_at,p.id`).all();
    return { body: { players: rows.map((row) => ({
      ...scoreById.get(row.id),
      checkedIn: !!row.checked_in,
      workOverride: !!row.eligible_override,
      excluded: !!row.excluded,
      reason: row.reason,
      submitted: !!row.submitted,
      suspectedDuplicate: row.same_identity_count > 1,
      qualified: !row.excluded && (!!row.submitted || (!!row.checked_in && !!row.eligible_override))
    })) } };
  });
  app.route("GET", /^\/api\/admin\/audit$/, (ctx) => {
    requireAdmin(ctx);
    return { body: { events: ctx.db.prepare(`SELECT id,kind,actor_id,target_id,details_json,occurred_at
      FROM audit_events ORDER BY id DESC LIMIT 100`).all().map((row) => ({
      id: row.id, kind: row.kind, actorId: row.actor_id, targetId: row.target_id,
      details: JSON.parse(row.details_json), occurredAt: row.occurred_at
    })) } };
  });
  app.route("POST", /^\/api\/admin\/bonus$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: addBonus(ctx.db, ctx.body.playerId, ctx.body.kind,
      ctx.body.points, ctx.body.reason, adminId, ctx.clock()) };
  });
  app.route("GET", /^\/api\/admin\/bonuses$/, (ctx) => {
    requireAdmin(ctx);
    return { body: { bonuses: ctx.db.prepare(`SELECT id,player_id,kind,points,reason,
      actor_id,created_at,voided_at FROM bonus_events ORDER BY created_at DESC,id DESC`).all() } };
  });
  app.route("POST", /^\/api\/admin\/bonuses\/([^/]+)\/void$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: voidBonus(ctx.db, ctx.match[1], ctx.body.reason, adminId, ctx.clock()) };
  });
  app.route("POST", /^\/api\/admin\/players\/([^/]+)\/check-in$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    markAttendance(ctx.db, ctx.match[1], adminId, ctx.clock());
    return { body: { ok: true } };
  });
  app.route("POST", /^\/api\/admin\/players\/([^/]+)\/work-override$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    grantWorkOverride(ctx.db, ctx.match[1], ctx.body.reason, adminId, ctx.clock());
    return { body: { ok: true } };
  });
  app.route("POST", /^\/api\/admin\/players\/([^/]+)\/exclude$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    excludePlayer(ctx.db, ctx.match[1], ctx.body.reason, adminId, ctx.clock());
    return { body: { ok: true } };
  });
  app.route("POST", /^\/api\/admin\/questions\/([^/]+)\/void$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    voidQuestion(ctx.db, ctx.match[1], ctx.body.reason, adminId, ctx.clock());
    return { body: { ok: true } };
  });
  app.route("POST", /^\/api\/admin\/pool\/freeze$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: freezePool(ctx.db, adminId, ctx.clock()) };
  });
}
