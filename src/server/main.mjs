import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.mjs";
import { buildApp } from "./app.mjs";
import { settleDueRounds } from "./rounds.mjs";

mkdirSync("data", { recursive: true });
const db = openDb(join("data", "game.sqlite"));
settleDueRounds(db, Date.now());
const app = buildApp(db, Date.now, { adminPasswordHash: process.env.ADMIN_PASSWORD_HASH });
const address = await app.listen(Number(process.env.PORT ?? 4173), process.env.HOST ?? "127.0.0.1");
console.log(`X-Lab game running at ${address}`);
