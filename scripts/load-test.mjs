import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/server/app.mjs";
import { openDb } from "../src/server/db.mjs";
import { hashAdminPassword } from "../src/server/auth.mjs";
import { makeQuestionBank } from "../tests/server/helpers.mjs";

const percent95 = (values) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0;

export async function runLoadTest({ clients = 300, submitters = 200 } = {}) {
  if (!Number.isInteger(clients) || !Number.isInteger(submitters) || clients < 1
    || submitters < 1 || submitters > clients || clients > 1000) {
    throw new Error("clients must be 1–1000, submitters must be 1–clients");
  }
  const directory = mkdtempSync(join(tmpdir(), "xlab-load-"));
  const db = openDb(join(directory, "load.sqlite"));
  let now = 1_000_000;
  let clock = () => now;
  const app = buildApp(db, () => clock(), { adminPasswordHash: hashAdminPassword("load-only-secret") });
  const url = await app.listen(0, "127.0.0.1");
  const post = async (path, body, cookie) => {
    const began = performance.now();
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xlab-action": "1", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    return { status: response.status, result, cookie: response.headers.get("set-cookie"), ms: performance.now() - began };
  };
  try {
    const issued = await Promise.all(Array.from({ length: clients }, (_, n) => post("/api/players", {
      realName: `压测用户${n}`, nickname: `LOAD${n}`, grade: 2025,
      team: ["software", "hardware", "operations", "design"][n % 4]
    })));
    const registered = issued.filter((entry) => entry.status === 201).length;
    if (registered !== clients) throw new Error(`Only ${registered}/${clients} registered`);
    const login = await post("/api/admin/login", { password: "load-only-secret" });
    if (login.status !== 200) throw new Error("Load admin login failed");
    const bank = await post("/api/admin/questions/import", { questions: makeQuestionBank() }, login.cookie);
    if (bank.status !== 200) throw new Error(`Question import failed: ${JSON.stringify(bank.result)}`);
    const started = await post("/api/admin/rounds/1/start", {}, login.cookie);
    if (started.status !== 200) throw new Error("Admin start failed");
    const deadline = started.result.deadlineAt;
    const burstStartedAt = performance.now();
    clock = () => deadline - 999 + (performance.now() - burstStartedAt);
    const submitted = await Promise.all(issued.slice(0, submitters).map((entry, n) =>
      post("/api/rounds/1/submit", {
        answers: { q1: 0, q2: 0, q3: 0, q4: 0, q5: 0, q6: 0 },
        requestKey: `load-${n}`
      }, entry.cookie)));
    const burstElapsedMs = Math.round(performance.now() - burstStartedAt);
    const accepted = submitted.filter((entry) => entry.status === 201).length;
    clock = () => deadline;
    now = deadline;
    const late = await post("/api/rounds/1/submit", { answers: { q1: 0 }, requestKey: "late" }, issued.at(-1).cookie);
    await fetch(`${url}/api/state`);
    const uniqueScores = db.prepare("SELECT COUNT(*) AS n FROM round_scores WHERE round_id=1").get().n;
    const duplicateScores = db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT player_id,round_id,COUNT(*) AS c FROM round_scores GROUP BY player_id,round_id HAVING c>1
    )`).get().n;
    return {
      clients, registered, submitters, accepted,
      rejected: submitters - accepted,
      lateRejected: late.status === 409,
      uniqueScores, duplicateScores,
      burstElapsedMs,
      p95Ms: Math.round(percent95(submitted.map((entry) => entry.ms))),
      maxMs: Math.round(Math.max(...submitted.map((entry) => entry.ms))),
      isolatedDatabase: true
    };
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : Number(args[i + 1]);
  };
  try {
    const result = await runLoadTest({
      clients: value("--clients", 300),
      submitters: value("--last-second-submits", 200)
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.accepted !== result.submitters || result.uniqueScores !== result.submitters
      || result.duplicateScores !== 0 || !result.lateRejected) process.exitCode = 1;
  } catch (error) {
    console.error(`Load test failed: ${error.message}`);
    process.exitCode = 1;
  }
}
