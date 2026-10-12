import { createPlatformPool } from "./db/pool.mjs";
import { migrate } from "./db/migrate.mjs";
import { buildPlatformApp } from "./http/app.mjs";

let pool;
try {
  pool = createPlatformPool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool);
  const app = buildPlatformApp({
    pool,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    trustedHttpsProxy: process.env.TRUSTED_HTTPS_PROXY === "1"
  });
  const host = process.env.HOST ?? "127.0.0.1";
  const address = await app.listen(Number(process.env.PORT ?? 4183), host);
  console.log(`Quiz platform listening at ${address}`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      await pool.end();
    } catch (error) {
      console.error("Shutdown error:", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(`平台启动失败: ${error.message}`);
  if (pool) await pool.end();
  process.exitCode = 1;
}
