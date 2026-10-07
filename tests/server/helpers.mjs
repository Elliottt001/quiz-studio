import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/db.mjs";

export function newTestDb() {
  const directory = mkdtempSync(join(tmpdir(), "xlab-game-"));
  const db = openDb(join(directory, "game.sqlite"));
  return {
    db,
    path: join(directory, "game.sqlite"),
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
