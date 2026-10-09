import { chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

export function resolveStorage(env = process.env) {
  const directory = resolve(env.DATA_DIR ?? "data");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return {
    directory,
    game: join(directory, "game.sqlite"),
    backup: join(directory, "backup-latest.sqlite")
  };
}

export function validateCampusProxy(env = process.env) {
  if (env.CAMPUS_PROXY_ONLY !== "1") return;
  if (env.HOST !== "127.0.0.1" || env.TRUSTED_HTTPS_PROXY !== "1"
    || !env.ADMIN_PASSWORD_HASH || !env.DATA_DIR?.startsWith("/")
    || !env.PUBLIC_ORIGIN || env.TLS_CERT_PATH || env.TLS_KEY_PATH) {
    throw new Error("校网代理模式要求本机监听、HTTPS 代理、管理员哈希、绝对数据目录和正式域名");
  }
  let origin;
  try { origin = new URL(env.PUBLIC_ORIGIN); } catch {}
  if (!origin || origin.protocol !== "https:" || origin.origin !== env.PUBLIC_ORIGIN) {
    throw new Error("校网代理模式的 PUBLIC_ORIGIN 必须是 HTTPS 域名源地址");
  }
}

export function validateCampusHttp(env = process.env) {
  if (env.CAMPUS_HTTP_ONLY !== "1") return;
  if (env.HOST !== "0.0.0.0" || !/^[1-9]\d{0,4}$/.test(env.PORT ?? "")
    || Number(env.PORT) > 65535 || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(env.ADMIN_PASSWORD_HASH ?? "")
    || !env.DATA_DIR?.startsWith("/") || env.PUBLIC_ORIGIN || env.PREVIEW_ORIGIN
    || env.TRUSTED_HTTPS_PROXY || env.CAMPUS_PROXY_ONLY
    || env.TLS_CERT_PATH || env.TLS_KEY_PATH) {
    throw new Error("校网 HTTP 模式要求 0.0.0.0、有效端口、管理员哈希、绝对数据目录，且不得混用 HTTPS 配置");
  }
}
