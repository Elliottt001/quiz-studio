import { createServer } from "node:http";
import { registerOrganizerRoutes } from "../organizers/routes.mjs";
import { requireOrganizer } from "../auth/sessions.mjs";
import { registerGameRoutes } from "../games/routes.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { registerPlayerRoutes } from "../players/routes.mjs";
import { registerQuizRoutes } from "../quiz/routes.mjs";
import { settleDueRounds } from "../quiz/repository.mjs";
import { httpError } from "./errors.mjs";

const unsafe = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildPlatformApp({
  pool, clock = Date.now, publicOrigin, trustedHttpsProxy = false, autoSettle = true
} = {}) {
  if (!pool) throw new Error("PostgreSQL pool is required");
  if (publicOrigin && (!publicOrigin.startsWith("https://")
    || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  const routes = [];
  const pending = new Map();
  let interval;
  let settling = Promise.resolve();
  let tickInProgress = false;
  const app = {
    route(method, pattern, handler) {
      routes.push({ method, pattern, handler });
    },
    pendingFor(slug, roundId) {
      return (pending.get(`${slug}:${roundId}`) ?? 0) > 0;
    },
    listen(port, host = "127.0.0.1") {
      if (!["127.0.0.1", "::1", "localhost"].includes(host)
        && !(publicOrigin && trustedHttpsProxy)) {
        return Promise.reject(new Error("公网监听需要明确配置可信 HTTPS 代理及 Origin"));
      }
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          if (autoSettle) {
            interval = setInterval(() => {
              if (tickInProgress) return;
              tickInProgress = true;
              settling = settleDueRounds(pool, clock(), (slug, id) => app.pendingFor(slug, id))
                .catch((error) => console.error("Platform settlement failed:", error))
                .finally(() => { tickInProgress = false; });
            }, 250);
            interval.unref();
          }
          const address = server.address();
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    async close() {
      clearInterval(interval);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await settling;
    }
  };
  const server = createServer(async (req, res) => {
    let submissionKey;
    try {
      const url = new URL(req.url, "http://localhost");
      const route = routes.find(({ method, pattern }) => method === req.method && pattern.test(url.pathname));
      if (!route) throw httpError(404, "not found");
      if (unsafe.has(req.method)) {
        if (req.headers["x-quiz-action"] !== "1") throw httpError(403, "请求来源不受信任");
        if (publicOrigin && req.headers.origin !== publicOrigin) {
          throw httpError(403, "请求来源不受信任");
        }
        if (!publicOrigin && req.headers.origin) {
          const origin = new URL(req.headers.origin);
          if (origin.protocol !== "http:" || origin.host !== req.headers.host) {
            throw httpError(403, "请求来源不受信任");
          }
        }
      }
      const largeRoundEdit = (req.method === "PUT"
        && /^\/v2\/games\/([0-9a-fA-F-]{36})\/rounds\/[0-9a-fA-F-]{36}$/.test(url.pathname))
        || (req.method === "POST"
        && /^\/v2\/games\/([0-9a-fA-F-]{36})\/rounds$/.test(url.pathname));
      if (largeRoundEdit) {
        const actor = await requireOrganizer(pool, req);
        const gameId = url.pathname.split("/")[3];
        await requireGameRole(pool, gameId, actor.id, ["owner"]);
      }
      const maxBytes = largeRoundEdit ? 1_048_576 : 65_536;
      const contentLength = Number(req.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw httpError(413, "请求过大");
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw httpError(413, "请求过大");
        chunks.push(chunk);
      }
      const receivedAt = clock();
      const incoming = req.method === "POST" && url.pathname.match(
        /^\/v2\/games\/([a-z0-9-]{3,48})\/rounds\/([0-9a-fA-F-]{36})\/submit$/
      );
      if (incoming) {
        submissionKey = `${incoming[1]}:${incoming[2]}`;
        pending.set(submissionKey, (pending.get(submissionKey) ?? 0) + 1);
      }
      if (chunks.length && !req.headers["content-type"]?.startsWith("application/json")) {
        throw httpError(415, "仅支持 JSON 请求");
      }
      let body;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        throw httpError(400, "JSON 格式无效");
      }
      if (unsafe.has(req.method) && (!body || typeof body !== "object" || Array.isArray(body))) {
        throw httpError(400, "请求体必须是 JSON 对象");
      }
      const match = url.pathname.match(route.pattern);
      const result = await route.handler({
        req, body, params: match.slice(1), receivedAt, pool, clock, secure: !!publicOrigin
      });
      res.writeHead(result?.status ?? 200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(result?.headers ?? {})
      });
      res.end(JSON.stringify(result?.body ?? {}));
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(error.status ?? 500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify({ error: error.status ? error.message : "服务暂不可用" }));
      }
      if (!error.status) console.error("Platform HTTP error:", error);
    } finally {
      if (submissionKey) {
        const left = pending.get(submissionKey) - 1;
        if (left) pending.set(submissionKey, left);
        else pending.delete(submissionKey);
      }
    }
  });
  app.route("GET", /^\/v2\/health$/, async () => {
    try {
      await pool.query("SELECT 1");
      return { body: { ok: true } };
    } catch {
      return { status: 503, body: { ok: false } };
    }
  });
  registerOrganizerRoutes(app);
  registerGameRoutes(app);
  registerPlayerRoutes(app);
  registerQuizRoutes(app);
  return app;
}
