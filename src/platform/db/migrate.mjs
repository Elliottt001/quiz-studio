import { readFileSync } from "node:fs";
import { withTransaction } from "./pool.mjs";

const migrations = [
  [1, readFileSync(new URL("./migrations/001_foundation.sql", import.meta.url), "utf8")],
  [2, readFileSync(new URL("./migrations/002_platform_audit.sql", import.meta.url), "utf8")],
  [3, readFileSync(new URL("./migrations/003_player_session_expiry.sql", import.meta.url), "utf8")],
  [4, readFileSync(new URL("./migrations/004_config_editor.sql", import.meta.url), "utf8")]
];

export async function migrate(pool) {
  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(760012345)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows
      .map(({ version }) => version));
    for (const [version, sql] of migrations) {
      if (applied.has(version)) continue;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    }
  });
}
