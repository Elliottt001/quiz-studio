import { stdin, stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformPool, withTransaction } from "../src/platform/db/pool.mjs";
import { migrate } from "../src/platform/db/migrate.mjs";
import { createOrganizer } from "../src/platform/organizers/repository.mjs";

export async function bootstrapPlatformOwner(pool, { login, password }) {
  if (typeof password !== "string" || password.trim().length < 6 || !/[^\d]/u.test(password)) {
    throw new Error("平台管理员口令至少6字符，不能只是数字");
  }
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(760012346)");
    const row = (await client.query(`SELECT count(*)::int AS n FROM organizers
      WHERE platform_admin=true`)).rows[0];
    if (row.n) throw new Error("平台管理员已存在，请使用已有账号管理组织者");
    return createOrganizer(client, { login, password, platformAdmin: true });
  });
}

async function readHidden(message) {
  if (!stdin.isTTY) throw new Error("必须在交互终端输入口令");
  stderr.write(message);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            stderr.write("\n");
            resolve(value);
            return;
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("已取消"));
            return;
          }
          if (char === "\u007f") { value = value.slice(0, -1); continue; }
          value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    pool = createPlatformPool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    const password = await readHidden("平台管理员口令（不回显）：");
    const confirmation = await readHidden("再次输入确认：");
    if (password !== confirmation) throw new Error("两次口令不一致");
    const admin = await bootstrapPlatformOwner(pool, { login: process.argv[2], password });
    stdout.write(`已创建平台管理员 ${admin.login}\n`);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
