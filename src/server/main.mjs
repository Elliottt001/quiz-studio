import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "./db.mjs";
import { buildApp } from "./app.mjs";
import { settleDueRounds } from "./rounds.mjs";
import { scoreRound } from "./answers.mjs";
import { backupDatabase } from "./backup.mjs";
import { resolveStorage } from "./config.mjs";

const storage = resolveStorage(process.env);
const db = openDb(storage.game);
let backupQueue = Promise.resolve();
function saveSnapshot() {
  backupQueue = backupQueue.catch(() => {}).then(() => backupDatabase(db, storage.backup));
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
  publicOrigin: process.env.PUBLIC_ORIGIN,
  previewOrigin: process.env.PREVIEW_ORIGIN,
  tlsTerminated: process.env.TRUSTED_HTTPS_PROXY === "1",
  secureCookies: !!tls || process.env.TRUSTED_HTTPS_PROXY === "1",
  onCriticalChange: saveSnapshot,
  staticDir: resolve("dist")
});
const address = await app.listen(Number(process.env.PORT ?? 4173), host);
console.log(`X-Lab game running at ${address}`);
