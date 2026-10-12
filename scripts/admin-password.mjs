import { stdin, stdout, stderr, exitCode } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashAdminPassword } from "../src/server/auth.mjs";

export function makeAdminHash(password) {
  if (typeof password !== "string" || password.trim().length < 6 || !/[^\d]/u.test(password)) {
    throw new Error("管理员口令至少6字符，不能只是数字");
  }
  return hashAdminPassword(password);
}

async function readHidden(prompt) {
  if (!stdin.isTTY) throw new Error("请在交互终端运行，以免管理员口令被记录");
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\r" || character === "\n") {
            stdin.off("data", onData);
            stderr.write("\n");
            resolve(value);
            return;
          }
          if (character === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("已取消"));
            return;
          }
          if (character === "\u007f") { value = value.slice(0, -1); continue; }
          value += character;
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
  try {
    const password = await readHidden("设置现场管理员口令（输入不回显）：");
    const confirm = await readHidden("再次输入确认：");
    if (password !== confirm) throw new Error("两次口令不一致");
    stdout.write(`${makeAdminHash(password)}\n`);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
