import { chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

export function resolveStorage(env = process.env) {
  const directory = resolve(env.DATA_DIR ?? "data");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return {
    directory,
    game: join(directory, "game.sqlite"),
    backup: join(directory, "backup-latest.sqlite")
  };
}
