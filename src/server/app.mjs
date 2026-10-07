import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIdentityRoutes } from "./routes/identity.mjs";
import { registerRoundRoutes } from "./routes/rounds.mjs";
import { registerAnswerRoutes } from "./routes/answers.mjs";
import { scoreRound } from "./answers.mjs";
import { registerStandingsRoutes } from "./routes/standings.mjs";
import { registerDrawRoutes } from "./routes/draw.mjs";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

export function buildApp(db, clock = Date.now, options = {}) {
  const routes = [];
  const tickers = [];
  let interval;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    for (const route of routes) {
      const match = req.method === route.method && url.pathname.match(route.pattern);
      if (!match) continue;
      try {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
          && req.headers["x-xlab-action"] !== "1") {
          res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "请求来源不受信任" }));
          return;
        }
        if (req.headers.origin) {
          let sameHost = false;
          try { sameHost = new URL(req.headers.origin).host === req.headers.host; } catch {}
          if (!sameHost) {
            res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "请求来源不受信任" }));
            return;
          }
        }
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > 64 * 1024) throw new Error("request too large");
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : {};
        const result = await route.handler({ req, db, clock, body, match, url });
        res.writeHead(result.status ?? 200, {
          "content-type": "application/json; charset=utf-8",
          ...(result.headers ?? {})
        });
        res.end(JSON.stringify(result.body ?? {}));
      } catch (error) {
        res.writeHead(error.status ?? 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const target = resolve(publicDir, name);
      if (target === publicDir || !target.startsWith(publicDir + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        const file = readFileSync(target);
        res.writeHead(200, {
          "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
          "cache-control": "no-store"
        });
        res.end(file);
        return;
      } catch {
        // The SPA routes are handled by the entry page.
        if (!extname(target)) {
          res.writeHead(200, { "content-type": contentTypes[".html"], "cache-control": "no-store" });
          res.end(readFileSync(resolve(publicDir, "index.html")));
          return;
        }
      }
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const app = {
    route(method, pattern, handler) { routes.push({ method, pattern, handler }); },
    tick(handler) { tickers.push(handler); },
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          interval = setInterval(() => {
            for (const tick of tickers) {
              try { tick({ db, clock }); } catch (error) { console.error("Game tick failed:", error); }
            }
          }, 250);
          interval.unref();
          const address = server.address();
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    close() {
      clearInterval(interval);
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  registerIdentityRoutes(app, options);
  registerRoundRoutes(app, scoreRound);
  registerAnswerRoutes(app, scoreRound);
  registerStandingsRoutes(app);
  registerDrawRoutes(app);
  return app;
}
