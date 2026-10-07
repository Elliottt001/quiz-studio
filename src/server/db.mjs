import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const schema = readFileSync(new URL("./migrations/001_core.sql", import.meta.url), "utf8");

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(schema);
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
