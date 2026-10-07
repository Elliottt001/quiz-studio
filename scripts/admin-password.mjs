import { stdin, stdout, stderr, exitCode } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashAdminPassword } from "../src/server/auth.mjs";

export function makeAdminHash(password) {
  if (typeof password !== "string" || password.trim().length < 16 || !/[^\d]/u.test(password)) {
    throw new Error("管理员口令至少16字符，不能只是数字");
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
    for await (const chunk of stdin) {
      const characters = chunk.toString("utf8");
      for (const character of characters) {
        if (character === "\r" || character === "\n") {
          stderr.write("\n");
          return value;
        }
        if (character === "\u0003") throw new Error("已取消");
        if (character === "\u007f") { value = value.slice(0, -1); continue; }
        value += character;
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  throw new Error("未收到口令");
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
