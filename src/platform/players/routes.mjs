import { clearSessionCookie, sessionCookie } from "../auth/sessions.mjs";
import { httpError } from "../http/errors.mjs";
import {
  loginPlayer, logoutPlayer, publishedGame, registerPlayer, requirePlayerForGame
} from "./repository.mjs";

const gamePath = "([a-z0-9-]{3,48})";

export function registerPlayerRoutes(app) {
  const failures = new Map();
  app.route("POST", new RegExp(`^/v2/games/${gamePath}/players$`),
    async ({ pool, params, body, secure }) => {
      const game = await publishedGame(pool, params[0]);
      const result = await registerPlayer(pool, game.id, body);
      return { status: 201, headers: {
        "set-cookie": sessionCookie(`game_session_${game.slug}`, result.sessionToken, secure)
      }, body: { id: result.playerId, loginCode: result.loginCode } };
    });
  app.route("POST", new RegExp(`^/v2/games/${gamePath}/login$`),
    async ({ pool, params, body, secure, req, clock }) => {
      const game = await publishedGame(pool, params[0]);
      const code = typeof body?.loginCode === "string" ? body.loginCode.trim().toUpperCase() : "";
      const key = `${game.id}:${code}:${req.socket.remoteAddress}`;
      const entry = failures.get(key);
      if (entry?.until > clock() && entry.count >= 8) throw httpError(429, "登录尝试过多");
      try {
        const result = await loginPlayer(pool, game.id, code, body?.password);
        failures.delete(key);
        return { headers: {
          "set-cookie": sessionCookie(`game_session_${game.slug}`, result.sessionToken, secure)
        }, body: { id: result.playerId } };
      } catch (error) {
        if (error.status === 401 && /^[A-F0-9]{16}$/.test(code)) {
          failures.set(key, { count: (entry?.until > clock() ? entry.count : 0) + 1,
            until: clock() + 60_000 });
          if (failures.size > 5_000) failures.delete(failures.keys().next().value);
        }
        throw error;
      }
    });
  app.route("POST", new RegExp(`^/v2/games/${gamePath}/logout$`),
    async ({ pool, params, req, secure }) => {
      const game = await publishedGame(pool, params[0]);
      await logoutPlayer(pool, req, game);
      return { headers: {
        "set-cookie": clearSessionCookie(`game_session_${game.slug}`, secure)
      }, body: { ok: true } };
    });
  app.route("GET", new RegExp(`^/v2/games/${gamePath}/me$`),
    async ({ pool, params, req }) => {
      const game = await publishedGame(pool, params[0]);
      const playerId = await requirePlayerForGame(pool, req, game.id);
      const row = (await pool.query(`SELECT id,display_name,login_code
        FROM players WHERE game_id=$1 AND id=$2`, [game.id, playerId])).rows[0];
      return { body: { id: row.id, displayName: row.display_name, loginCode: row.login_code } };
    });
}
