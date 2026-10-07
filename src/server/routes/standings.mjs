import { requireAdmin } from "../auth.mjs";
import {
  addBonus, markAttendance, grantWorkOverride, excludePlayer, voidQuestion,
  listStandings, freezePool, getFreeze
} from "../standings.mjs";

export function registerStandingsRoutes(app) {
  app.route("GET", /^\/api\/standings$/, ({ db }) => ({ body: { players: listStandings(db) } }));
  app.route("GET", /^\/api\/pool$/, ({ db }) => ({ body: { pool: getFreeze(db) } }));
  app.route("GET", /^\/api\/admin\/players$/, (ctx) => {
    requireAdmin(ctx);
    const scoreById = new Map(listStandings(ctx.db).map((player) => [player.id, player]));
    const rows = ctx.db.prepare(`SELECT p.id,p.real_name,p.nickname,p.grade,p.team,
      e.checked_in,e.eligible_override,e.excluded,e.reason,
      EXISTS(SELECT 1 FROM submissions s WHERE s.player_id=p.id) AS submitted
      FROM players p JOIN eligibility e ON e.player_id=p.id ORDER BY p.created_at,p.id`).all();
    return { body: { players: rows.map((row) => ({
      ...scoreById.get(row.id),
      checkedIn: !!row.checked_in,
      workOverride: !!row.eligible_override,
      excluded: !!row.excluded,
      reason: row.reason,
      submitted: !!row.submitted,
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
