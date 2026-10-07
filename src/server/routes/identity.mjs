import {
  registerPlayer, requirePlayer, requireAdmin, createRecoveryCode, redeemRecoveryCode,
  createAdminSession, verifyAdminPassword, sessionCookie, httpError
} from "../auth.mjs";

export function registerIdentityRoutes(app, options = {}) {
  const secure = options.secureCookies ?? false;
  const failedLogins = new Map();
  app.route("POST", /^\/api\/players$/, ({ db, clock, body }) => {
    const active = db.prepare("SELECT status FROM rounds WHERE id=4").get();
    if (active?.status === "published" || active?.status === "voided") {
      throw httpError(409, "报名已结束");
    }
    const { playerId, sessionToken } = registerPlayer(db, body, clock());
    return {
      status: 201,
      headers: { "set-cookie": sessionCookie("player_session", sessionToken, secure) },
      body: { id: playerId }
    };
  });
  app.route("GET", /^\/api\/me$/, (ctx) => {
    const id = requirePlayer(ctx);
    const row = ctx.db.prepare("SELECT id,real_name,nickname,grade,team FROM players WHERE id=?").get(id);
    return { body: { id: row.id, realName: row.real_name, nickname: row.nickname, grade: row.grade, team: row.team } };
  });
  app.route("POST", /^\/api\/admin\/login$/, ({ req, db, clock, body }) => {
    const address = req.socket.remoteAddress ?? "unknown";
    const prior = failedLogins.get(address);
    if (prior && prior.until > clock() && prior.count >= 5) {
      throw httpError(429, "请稍后重试管理员登录");
    }
    if (!verifyAdminPassword(body.password, options.adminPasswordHash)) {
      const current = prior && prior.until > clock() ? prior : { count: 0, until: clock() + 60_000 };
      failedLogins.set(address, { count: current.count + 1, until: current.until });
      throw httpError(401, "管理员口令错误");
    }
    failedLogins.delete(address);
    const adminToken = createAdminSession(db, clock());
    return {
      headers: { "set-cookie": sessionCookie("admin_session", adminToken, secure) },
      body: { ok: true }
    };
  });
  app.route("GET", /^\/api\/admin\/session$/, (ctx) => {
    requireAdmin(ctx);
    return { body: { ok: true } };
  });
  app.route("POST", /^\/api\/admin\/players\/([^/]+)\/recover$/, (ctx) => {
    requireAdmin(ctx);
    return { body: { code: createRecoveryCode(ctx.db, ctx.match[1], ctx.clock()) } };
  });
  app.route("POST", /^\/api\/players\/recover$/, ({ db, clock, body }) => {
    const sessionToken = redeemRecoveryCode(db, body.code, clock());
    return {
      headers: { "set-cookie": sessionCookie("player_session", sessionToken, secure) },
      body: { ok: true }
    };
  });
}
