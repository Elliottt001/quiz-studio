import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isPrivateIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function validGameOrigin(value) {
  try {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/$/, "") || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return isPrivateIpv4(url.hostname) && !!url.port;
  } catch {}
  return false;
}

export async function probeGame(origin, request = fetch) {
  const base = new URL(origin);
  const checks = [
    ["/api/health", "健康检查", async (response) =>
      response.headers.get("content-type")?.includes("application/json")
      && (await response.json()).ok === true],
    ["/", "玩家入口", async (response) =>
      (await response.text()).includes('src="/js/player.mjs"')],
    ["/admin.html", "管理员入口", async (response) =>
      (await response.text()).includes('src="/js/admin.mjs"')],
    ["/display.html", "大屏入口", async (response) =>
      (await response.text()).includes('src="/js/display.mjs"')]
  ];
  for (const [path, label, valid] of checks) {
    let response;
    try {
      response = await request(new URL(path, base), { signal: AbortSignal.timeout(8000) });
    } catch (error) {
      throw new Error(`${label}无法连接：${error.message}`);
    }
    if (!response.ok || !await valid(response)) {
      throw new Error(`${label}未通过：此地址尚未提供完整游戏（HTTP ${response.status}）`);
    }
  }
  return { health: true, player: true, admin: true, display: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.argv[2] ?? process.env.PUBLIC_ORIGIN;
  if (!origin) {
    console.error("请指定实际游戏入口：npm run verify:campus -- http://内网IP:4173");
    process.exitCode = 1;
  } else if (!validGameOrigin(origin)) {
    console.error("入口必须是私有 IPv4 的 HTTP IP:端口，或有效 HTTPS 域名源地址");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await probeGame(origin), null, 2));
    } catch (error) {
      console.error(`校网入口未就绪：${error.message}`);
      process.exitCode = 1;
    }
  }
}
