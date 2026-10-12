import pg from "pg";

export function createPlatformPool({ connectionString, max = 16, searchPath } = {}) {
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  if (!Number.isInteger(max) || max < 1 || max > 64) {
    throw new Error("Database pool max must be between 1 and 64");
  }
  if (searchPath && !/^test_[a-f0-9]{16}$/.test(searchPath)) {
    throw new Error("Invalid isolated test schema");
  }
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(searchPath ? { options: `-c search_path=${searchPath}` } : {})
  });
  pool.on("error", (error) => console.error("Idle PostgreSQL connection failed:", error));
  return pool;
}

export async function withTransaction(pool, operation) {
  const client = await pool.connect();
  let discard;
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = rollbackError;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
