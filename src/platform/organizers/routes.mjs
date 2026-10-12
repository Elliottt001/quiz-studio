import {
  clearSessionCookie, cookieValue, requireOrganizer, sessionCookie
} from "../auth/sessions.mjs";
import { createOrganizer, loginOrganizer, logoutOrganizer } from "./repository.mjs";
import { httpError } from "../http/errors.mjs";
import { withTransaction } from "../db/pool.mjs";

export function registerOrganizerRoutes(app) {
  const failures = new Map();
  app.route("POST", /^\/v2\/auth\/login$/, async ({ body, pool, clock, secure, req }) => {
    const login = typeof body.login === "string" ? body.login.trim().toLowerCase() : "";
    const key = `${login}:${req.socket.remoteAddress}`;
    const entry = failures.get(key);
    if (entry?.until > clock() && entry.count >= 8) {
      throw httpError(429, "登录尝试过多，请稍后再试");
    }
    try {
      const token = await loginOrganizer(pool, body.login, body.password, clock());
      failures.delete(key);
      return { headers: { "set-cookie": sessionCookie("organizer_session", token, secure) },
        body: { ok: true } };
    } catch (error) {
      if (error.status === 401 && /^[a-z0-9-]{3,32}$/.test(login)) {
        failures.set(key, { count: (entry?.until > clock() ? entry.count : 0) + 1,
          until: clock() + 60_000 });
        if (failures.size > 1000) failures.delete(failures.keys().next().value);
      }
      throw error;
    }
  });
  app.route("POST", /^\/v2\/auth\/logout$/, async ({ req, pool, secure }) => {
    await logoutOrganizer(pool, cookieValue(req, "organizer_session"));
    return { headers: { "set-cookie": clearSessionCookie("organizer_session", secure) },
      body: { ok: true } };
  });
  app.route("POST", /^\/v2\/organizers$/, async ({ body, pool, req, clock }) => {
    const actor = await requireOrganizer(pool, req);
    if (!actor.platform_admin) throw httpError(403, "仅平台管理员可创建组织者");
    const organizer = await withTransaction(pool, async (client) => {
      const created = await createOrganizer(client, {
        login: body.login, password: body.password
      });
      await client.query(`INSERT INTO platform_audit_events
        (actor_id,target_id,kind,details_json,occurred_at) VALUES($1,$2,$3,$4,$5)`,
      [actor.id, created.id, "organizer_created", { login: created.login }, clock()]);
      return created;
    });
    return { status: 201, body: organizer };
  });
}
