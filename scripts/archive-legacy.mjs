import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { inspectBackup } from "./backup-check.mjs";

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

export async function archiveLegacy({ source, archiveDir }) {
  const sourcePath = resolve(source);
  const destination = resolve(archiveDir);
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
    throw new Error("旧数据库不存在或不是普通文件");
  }
  if (existsSync(destination)) throw new Error("存档目录已存在");
  if (isInside(repositoryRoot, destination)) throw new Error("存档目录必须位于仓库外");
  const parent = realpathSync(dirname(destination));
  if (isInside(repositoryRoot, join(parent, basename(destination)))) {
    throw new Error("存档目录必须位于仓库外");
  }
  const snapshot = join(destination, "legacy.sqlite");
  const manifest = join(destination, "manifest.json");
  const temporary = join(destination, "legacy.sqlite.tmp");
  mkdirSync(destination, { mode: 0o700 });
  chmodSync(destination, 0o700);
  try {
    const db = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(db, temporary);
    } finally {
      db.close();
    }
    const counts = inspectBackup(temporary);
    const sha256 = createHash("sha256").update(readFileSync(temporary)).digest("hex");
    chmodSync(temporary, 0o600);
    renameSync(temporary, snapshot);
    writeFileSync(manifest, JSON.stringify({ sha256, counts }, null, 2), {
      mode: 0o600, flag: "wx"
    });
    return { snapshot, manifest, sha256, counts };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("用法: node scripts/archive-legacy.mjs <旧库路径> <仓库外的新存档目录>");
    process.exitCode = 2;
  } else {
    try {
      const result = await archiveLegacy({ source: process.argv[2], archiveDir: process.argv[3] });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`存档失败: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
