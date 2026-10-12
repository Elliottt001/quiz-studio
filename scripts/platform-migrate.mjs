import { createPlatformPool } from "../src/platform/db/pool.mjs";
import { migrate } from "../src/platform/db/migrate.mjs";

let pool;
try {
  pool = createPlatformPool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool);
  console.log("平台数据库迁移完成");
} catch (error) {
  console.error(`平台数据库迁移失败: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
