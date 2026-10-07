import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { backup } from "node:sqlite";
import { openDb } from "./db.mjs";

export async function backupDatabase(db, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await backup(db, temporary);
    const check = openDb(temporary);
    try {
      if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
        throw new Error("数据库备份校验失败");
      }
    } finally { check.close(); }
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
