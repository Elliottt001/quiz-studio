import { chmodSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const schema = readFileSync(new URL("./migrations/001_core.sql", import.meta.url), "utf8");

export function openDb(path) {
  if (path !== ":memory:" && existsSync(path)) chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  const columns = new Set(db.prepare("PRAGMA table_info(players)").all().map(({ name }) => name));
  if (!columns.has("login_code")) db.exec("ALTER TABLE players ADD COLUMN login_code TEXT");
  if (!columns.has("password_hash")) db.exec("ALTER TABLE players ADD COLUMN password_hash TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS players_login_code_unique ON players(login_code)");
  const legacy = db.prepare("SELECT id FROM players WHERE login_code IS NULL").all();
  if (legacy.length) {
    const assign = db.prepare("UPDATE players SET login_code=? WHERE id=?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { id } of legacy) assign.run(randomBytes(8).toString("hex").toUpperCase(), id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

export function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
