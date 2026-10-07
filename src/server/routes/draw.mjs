import { requireAdmin } from "../auth.mjs";
import { configurePrizes, drawWinner, listDraws, refusePrize, confirmPrize } from "../draw.mjs";

export function registerDrawRoutes(app) {
  app.route("GET", /^\/api\/draws$/, ({ db }) => ({ body: { draws: listDraws(db) } }));
  app.route("POST", /^\/api\/admin\/prizes$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: configurePrizes(ctx.db, ctx.body.prizes, adminId, ctx.clock()) };
  });
  app.route("POST", /^\/api\/admin\/prizes\/([^/]+)\/draw$/, (ctx) => {
    requireAdmin(ctx);
    return { body: drawWinner(ctx.db, ctx.match[1], ctx.body.requestKey, undefined, ctx.clock()) };
  });
  app.route("POST", /^\/api\/admin\/draws\/([^/]+)\/refuse$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: refusePrize(ctx.db, ctx.match[1], ctx.body.reason, adminId, ctx.clock()) };
  });
  app.route("POST", /^\/api\/admin\/draws\/([^/]+)\/confirm$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: confirmPrize(ctx.db, ctx.match[1], adminId, ctx.clock()) };
  });
}
