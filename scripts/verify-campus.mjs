import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    console.error("请指定实际游戏域名：npm run verify:campus -- https://实际域名");
    process.exitCode = 1;
  } else if (!origin.startsWith("https://")) {
    console.error("正式入口必须是 HTTPS 域名");
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
