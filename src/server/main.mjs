import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "./db.mjs";
import { buildApp } from "./app.mjs";
import { settleDueRounds } from "./rounds.mjs";
import { scoreRound } from "./answers.mjs";
import { backupDatabase } from "./backup.mjs";

mkdirSync("data", { recursive: true, mode: 0o700 });
chmodSync("data", 0o700);
const db = openDb(join("data", "game.sqlite"));
let backupQueue = Promise.resolve();
function saveSnapshot() {
  backupQueue = backupQueue.catch(() => {}).then(() => backupDatabase(db, join("data", "backup-latest.sqlite")));
  return backupQueue;
}
if (settleDueRounds(db, Date.now(), scoreRound).length) await saveSnapshot();
const host = process.env.HOST ?? "127.0.0.1";
const tls = process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH
  ? { cert: readFileSync(process.env.TLS_CERT_PATH), key: readFileSync(process.env.TLS_KEY_PATH) }
  : undefined;
const app = buildApp(db, Date.now, {
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
  tls,
  secureCookies: !!tls,
  onCriticalChange: saveSnapshot,
  staticDir: resolve("dist")
});
const address = await app.listen(Number(process.env.PORT ?? 4173), host);
console.log(`X-Lab game running at ${address}`);
