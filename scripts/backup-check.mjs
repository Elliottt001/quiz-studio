import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export function inspectBackup(path) {
  let details;
  try {
    details = statSync(path);
  } catch {
    throw new Error("备份文件不存在");
  }
  if (!details.isFile() || details.size < 100) throw new Error("备份文件无效或损坏");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
      throw new Error("备份文件损坏");
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM rounds").get().n !== 4) {
      throw new Error("备份文件无效：缺少四轮数据");
    }
    return {
      integrity: "ok",
      players: db.prepare("SELECT COUNT(*) AS n FROM players").get().n,
      submissions: db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n,
      scores: db.prepare("SELECT COUNT(*) AS n FROM round_scores").get().n,
      freezeHash: db.prepare("SELECT hash FROM freeze_snapshots LIMIT 1").get()?.hash ?? null,
      draws: db.prepare("SELECT COUNT(*) AS n FROM draws").get().n,
      deadlines: db.prepare("SELECT deadline_at FROM rounds ORDER BY id").all().map((row) => row.deadline_at)
    };
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? "data/backup-latest.sqlite";
  try {
    console.log(JSON.stringify(inspectBackup(file), null, 2));
  } catch (error) {
    console.error(`Backup check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
