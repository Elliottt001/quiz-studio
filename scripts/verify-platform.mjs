import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function load(base, path, kind) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    if (kind === "json") {
      if (!response.headers.get("content-type")?.includes("application/json")) return null;
      return await response.json();
    }
    if (!response.headers.get("content-type")?.includes("text/html")) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export async function verifyPlatform(baseUrl, slug) {
  let base;
  try {
    base = new URL(baseUrl).origin;
  } catch {
    throw new Error("请提供有效的平台入口地址");
  }
  if (!/^[a-z0-9-]{3,48}$/.test(slug ?? "")) {
    throw new Error("请提供一场已发布游戏的标识");
  }
  const [health, home, organizer, player, state] = await Promise.all([
    load(base, "/v2/health", "json"),
    load(base, "/", "html"),
    load(base, "/organizer", "html"),
    load(base, `/g/${slug}`, "html"),
    load(base, `/v2/games/${slug}/state`, "json")
  ]);
  return {
    health: health?.ok === true,
    home: typeof home === "string"
      && home.includes("答题游戏工坊") && home.includes('lang="zh-CN"'),
    organizer: typeof organizer === "string"
      && organizer.includes("游戏创建者控制台") && organizer.includes('lang="zh-CN"'),
    player: typeof player === "string"
      && player.includes("专属游戏入口") && player.includes('lang="zh-CN"'),
    state: state?.game?.slug === slug && Array.isArray(state.rounds)
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyPlatform(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    if (Object.values(result).some((ok) => !ok)) process.exitCode = 1;
  } catch (error) {
    console.error(`平台验证失败: ${error.message}`);
    process.exitCode = 2;
  }
}
