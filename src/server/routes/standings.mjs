import { requireAdmin } from "../auth.mjs";
import {
  addBonus, markAttendance, excludePlayer, voidQuestion, listStandings, freezePool, getFreeze
} from "../standings.mjs";

export function registerStandingsRoutes(app) {
  app.route("GET", /^\/api\/standings$/, ({ db }) => ({ body: { players: listStandings(db) } }));
  app.route("GET", /^\/api\/pool$/, ({ db }) => ({ body: { pool: getFreeze(db) } }));
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
