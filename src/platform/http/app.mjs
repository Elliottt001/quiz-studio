import { createServer } from "node:http";
import { registerOrganizerRoutes } from "../organizers/routes.mjs";
import { registerGameRoutes } from "../games/routes.mjs";
import { registerPlayerRoutes } from "../players/routes.mjs";
import { registerQuizRoutes } from "../quiz/routes.mjs";
import { httpError } from "./errors.mjs";

const unsafe = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildPlatformApp({ pool, clock = Date.now, publicOrigin, trustedHttpsProxy = false } = {}) {
  if (!pool) throw new Error("PostgreSQL pool is required");
  if (publicOrigin && (!publicOrigin.startsWith("https://")
    || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  const routes = [];
  const app = {
    route(method, pattern, handler) {
      routes.push({ method, pattern, handler });
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
          const address = server.address();
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  const server = createServer(async (req, res) => {
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
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65_536) throw httpError(413, "请求过大");
        chunks.push(chunk);
      }
      const receivedAt = clock();
      if (chunks.length && !req.headers["content-type"]?.startsWith("application/json")) {
        throw httpError(415, "仅支持 JSON 请求");
      }
      let body;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        throw httpError(400, "JSON 格式无效");
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
    }
  });
  registerOrganizerRoutes(app);
  registerGameRoutes(app);
  registerPlayerRoutes(app);
  registerQuizRoutes(app);
  return app;
}
