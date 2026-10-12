import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { startRound } from "../../src/platform/quiz/repository.mjs";

export async function preparedFourTypes(pool) {
  const owner = await createOrganizer(pool, {
    login: "owner", password: "owner-password-1"
  });
  const game = await createGame(pool, owner.id, { slug: "four-types", title: "四种题型" });
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: 1, position: 1, title: "四题",
    durationMs: 30_000,
    questions: [
      { position: 1, kind: "choice", prompt: "选择", options: ["错", "对"],
        points: 7, answerRule: { correctOption: 1 } },
      { position: 2, kind: "multiple", prompt: "多选", options: ["甲", "乙", "丙"],
        points: 10, answerRule: { correctOptions: [0, 2] } },
      { position: 3, kind: "exact", prompt: "填空", points: 5,
        answerRule: { accepted: ["ＡBC", "Ada"] } },
      { position: 4, kind: "length", prompt: "五个字的感受", points: 10,
        answerRule: { minLength: 5, maxLength: 120 } }
    ]
  });
  await publishFrozen(pool, game.id, owner.id);
  const questions = (await pool.query(`SELECT id,position FROM questions
    WHERE game_id=$1 ORDER BY position`, [game.id])).rows;
  await startRound(pool, game.id, round.id, owner.id, 1000);
  return { owner, game, round, questions };
}
