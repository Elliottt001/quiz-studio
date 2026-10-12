import { randomBytes } from "node:crypto";
import { createPlatformPool } from "../../src/platform/db/pool.mjs";
import { migrate } from "../../src/platform/db/migrate.mjs";

export async function newPlatformFixture({ migrateSchema = true } = {}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || new URL(connectionString).pathname !== "/quiz_platform_test") {
    throw new Error("TEST_DATABASE_URL must target quiz_platform_test");
  }
  const schema = `test_${randomBytes(8).toString("hex")}`;
  const root = createPlatformPool({ connectionString, max: 2 });
  await root.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPlatformPool({ connectionString, max: 2, searchPath: schema });
  if (migrateSchema) await migrate(pool);
  return {
    pool,
    async close() {
      await pool.end();
      await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      await root.end();
    }
  };
}
