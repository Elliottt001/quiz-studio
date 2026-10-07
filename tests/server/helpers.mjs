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

export function makeQuestionBank() {
  let index = 0;
  return [6, 10, 9, 5].flatMap((count, roundOffset) =>
    Array.from({ length: count }, (_, position) => {
      index++;
      const reflection = roundOffset === 3 && position === 4;
      return {
        id: `q${index}`,
        roundId: roundOffset + 1,
        position: position + 1,
        kind: reflection ? "reflection" : "choice",
        prompt: reflection ? "听完分享，你对训练营有什么感受？" : `第${index}题`,
        ...(reflection ? {} : { options: ["甲", "乙", "丙", "丁"], correctOption: 0 }),
        explanation: reflection ? "表达感受即得分" : "标准答案为甲",
        source: "已审核的分享材料"
      };
    })
  );
}
