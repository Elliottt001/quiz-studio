import {
  registerPlayer, requirePlayer, requireAdmin, createRecoveryCode, redeemRecoveryCode,
  createAdminSession, verifyAdminPassword, sessionCookie, httpError,
  validatePlayerPassword, loginPlayer, logoutPlayer, cookieValue, setRecoveredPassword,
  resolvePlayer, logoutAdmin
} from "../auth.mjs";
import { LoginLimiter } from "../login-limiter.mjs";

export function registerIdentityRoutes(app, options = {}) {
  const secure = options.secureCookies ?? !!(options.tls || options.tlsTerminated);
  const failedPlayerLogins = new LoginLimiter();
  const clearCookie = (name) => `${name}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;
  const revokeAdminFromBrowser = ({ req, db }) => {
    const previous = cookieValue(req, "admin_session");
    if (previous) {
      try { logoutAdmin(db, previous); } catch (error) { if (error.status !== 401) throw error; }
    }
    return previous;
  };
  const revokePlayerFromBrowser = ({ req, db, clock }) => {
    const previous = cookieValue(req, "player_session");
    if (previous) {
      try { logoutPlayer(db, previous, clock()); } catch (error) { if (error.status !== 401) throw error; }
    }
    return previous;
  };
  app.route("POST", /^\/api\/players$/, (ctx) => {
    const { db, clock, body } = ctx;
    validatePlayerPassword(body.password);
    const active = db.prepare("SELECT status FROM rounds WHERE id=4").get();
    if (active?.status === "published" || active?.status === "voided") {
      throw httpError(409, "报名已结束");
    }
    const { playerId, sessionToken, loginCode } = registerPlayer(db, body, clock());
    revokePlayerFromBrowser(ctx);
    const priorAdmin = revokeAdminFromBrowser(ctx);
    return {
      status: 201,
      headers: {
        "set-cookie": [
          sessionCookie("player_session", sessionToken, secure),
          ...(priorAdmin ? [clearCookie("admin_session")] : [])
        ]
      },
      body: { id: playerId, loginCode }
    };
  });
  app.route("POST", /^\/api\/players\/login$/, (ctx) => {
    const { db, clock, body } = ctx;
    const code = typeof body.loginCode === "string" ? body.loginCode.trim().toUpperCase() : "";
    if (failedPlayerLogins.blocked(code, clock())) throw httpError(429, "登录尝试过多，请稍后重试");
    try {
      const result = loginPlayer(db, code, body.password, clock());
      revokePlayerFromBrowser(ctx);
      const priorAdmin = revokeAdminFromBrowser(ctx);
      failedPlayerLogins.success(code);
      return {
        headers: {
          "set-cookie": [
            sessionCookie("player_session", result.sessionToken, secure),
            ...(priorAdmin ? [clearCookie("admin_session")] : [])
          ]
        },
        body: { id: result.playerId }
      };
    } catch (error) {
      if (db.prepare("SELECT 1 FROM players WHERE login_code=?").get(code)) {
        failedPlayerLogins.failure(code, clock());
      }
      throw error;
    }
  });
  app.route("POST", /^\/api\/players\/logout$/, (ctx) => {
    logoutPlayer(ctx.db, cookieValue(ctx.req, "player_session"), ctx.clock());
    return {
      headers: { "set-cookie": clearCookie("player_session") },
      body: { ok: true }
    };
  });
  app.route("GET", /^\/api\/me$/, (ctx) => {
    const id = requirePlayer(ctx);
    const row = ctx.db.prepare("SELECT id,real_name,nickname,grade,team,login_code FROM players WHERE id=?").get(id);
    return { body: {
      id: row.id, realName: row.real_name, nickname: row.nickname,
      grade: row.grade, team: row.team, loginCode: row.login_code
    } };
  });
  app.route("POST", /^\/api\/admin\/login$/, (ctx) => {
    const { db, clock, body } = ctx;
    if (!verifyAdminPassword(body.password, options.adminPasswordHash)) {
      throw httpError(401, "管理员口令错误");
    }
    const adminToken = createAdminSession(db, clock());
    const priorPlayer = revokePlayerFromBrowser(ctx);
    return {
      headers: {
        "set-cookie": [
          sessionCookie("admin_session", adminToken, secure),
          ...(priorPlayer ? [clearCookie("player_session")] : [])
        ]
      },
      body: { ok: true }
    };
  });
  app.route("GET", /^\/api\/admin\/session$/, (ctx) => {
    requireAdmin(ctx);
    return { body: { ok: true } };
  });
  app.route("POST", /^\/api\/admin\/logout$/, (ctx) => {
    requireAdmin(ctx);
    logoutAdmin(ctx.db, cookieValue(ctx.req, "admin_session"));
    return {
      headers: {
        "set-cookie": clearCookie("admin_session")
      },
      body: { ok: true }
    };
  });
  app.route("POST", /^\/api\/admin\/players\/([^/]+)\/recover$/, (ctx) => {
    requireAdmin(ctx);
    return { body: { code: createRecoveryCode(ctx.db, ctx.match[1], ctx.clock()) } };
  });
  app.route("POST", /^\/api\/players\/recover$/, (ctx) => {
    const { db, clock, body } = ctx;
    validatePlayerPassword(body.password);
    const sessionToken = redeemRecoveryCode(db, body.code, clock());
    const playerId = resolvePlayer(db, sessionToken);
    const loginCode = setRecoveredPassword(db, playerId, body.password);
    revokePlayerFromBrowser(ctx);
    const priorAdmin = revokeAdminFromBrowser(ctx);
    return {
      headers: {
        "set-cookie": [
          sessionCookie("player_session", sessionToken, secure),
          ...(priorAdmin ? [clearCookie("admin_session")] : [])
        ]
      },
      body: { ok: true, loginCode }
    };
  });
}
