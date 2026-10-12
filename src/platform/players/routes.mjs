import { clearSessionCookie, sessionCookie } from "../auth/sessions.mjs";
import { httpError } from "../http/errors.mjs";
import { requireOrganizer } from "../auth/sessions.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { issueRecovery, redeemRecovery } from "./recovery.mjs";
import {
  loginPlayer, logoutPlayer, publishedGame, registerPlayer, requirePlayerForGame
} from "./repository.mjs";

const gamePath = "([a-z0-9-]{3,48})";

export function registerPlayerRoutes(app) {
  const failures = new Map();
  const failedRecovery = new Map();
  app.route("GET", new RegExp(`^/v2/games/${gamePath}/registration$`),
    async ({ pool, params }) => {
      const game = await publishedGame(pool, params[0]);
      const row = (await pool.query(`SELECT g.title,g.published_version,v.config_json
        FROM games g JOIN game_versions v ON v.game_id=g.id
          AND v.version=COALESCE(g.published_version,1)
        WHERE g.id=$1`, [game.id])).rows[0];
      const fields = (row.config_json.fields ?? []).map(({ help, ...field }) =>
        help ? { ...field, help } : field);
      return { body: {
        game: { slug: game.slug, title: row.title,
          description: row.config_json.description ?? "" },
        fields
      } };
    });
  app.route("GET", /^\/v2\/games\/([0-9a-fA-F-]{36})\/players$/,
    async ({ pool, params, req }) => {
      const actor = await requireOrganizer(pool, req);
      await requireGameRole(pool, params[0], actor.id, ["owner", "operator"]);
      const rows = (await pool.query(`SELECT p.id,p.display_name,p.profile_json,
        COALESCE(SUM(s.points),0)::int AS score FROM players p
        LEFT JOIN round_scores s ON s.game_id=p.game_id AND s.player_id=p.id
        WHERE p.game_id=$1 GROUP BY p.game_id,p.id,p.display_name,p.profile_json
        ORDER BY p.created_at,p.id`, [params[0]])).rows;
      return { body: { players: rows.map((row) => ({
        id: row.id, displayName: row.display_name, profile: row.profile_json,
        score: row.score
      })) } };
    });
  app.route("POST", /^\/v2\/games\/([0-9a-fA-F-]{36})\/players\/([0-9a-fA-F-]{36})\/recovery$/,
    async ({ pool, params, req, clock }) => {
      const actor = await requireOrganizer(pool, req);
      const code = await issueRecovery(pool, params[0], params[1], actor.id, clock());
      return { body: { code } };
    });
  app.route("POST", new RegExp(`^/v2/games/${gamePath}/recover$`),
    async ({ pool, params, body, clock, secure, req }) => {
      const game = await publishedGame(pool, params[0]);
      const key = `${game.id}:${req.socket.remoteAddress}:${
        typeof body?.code === "string" ? body.code.slice(0, 12) : ""}`;
      const entry = failedRecovery.get(key);
      if (entry?.until > clock() && entry.count >= 8) {
        throw httpError(429, "恢复尝试过多，请稍后再试");
      }
      try {
        const result = await redeemRecovery(pool, game.id, body?.code, body?.password, clock());
        failedRecovery.delete(key);
        return { headers: {
          "set-cookie": sessionCookie(`game_session_${game.slug}`, result.sessionToken, secure)
        }, body: { id: result.playerId, loginCode: result.loginCode } };
      } catch (error) {
        if (error.status === 409) {
          failedRecovery.set(key, {
            count: (entry?.until > clock() ? entry.count : 0) + 1,
            until: clock() + 60_000
          });
          if (failedRecovery.size > 2_000) {
            failedRecovery.delete(failedRecovery.keys().next().value);
          }
        }
        throw error;
      }
    });
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
      const row = (await pool.query(`SELECT id,display_name,login_code,profile_json
        FROM players WHERE game_id=$1 AND id=$2`, [game.id, playerId])).rows[0];
      return { body: { id: row.id, displayName: row.display_name,
        loginCode: row.login_code, profile: row.profile_json } };
    });
}
