import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import {
  startRound, submitAnswers, settleDueRounds, getPublicRound
} from "../../src/platform/quiz/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";
import { preparedFourTypes } from "./quiz-fixtures.mjs";

test("four question types score deterministically without leaking current keys or a player's reflection", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const { game, round, questions } = await preparedFourTypes(pool);
    const player = await registerPlayer(pool, game.id, {
      displayName: "Player", password: "player-password-1"
    });
    const answers = {
      [questions[0].id]: 1,
      [questions[1].id]: [2, 0],
      [questions[2].id]: " abc ",
      [questions[3].id]: "我的游戏感受很好"
    };
    const open = await getPublicRound(pool, game.id, round.id);
    assert.equal(open.questions.length, 4);
    assert.equal(JSON.stringify(open).includes("correctOptions"), false);
    assert.equal(JSON.stringify(open).includes("accepted"), false);
    assert.deepEqual(open.questions[3].answerRule, { minLength: 5, maxLength: 120 });
    const submitted = await submitAnswers(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers, requestKey: "one", receivedAt: 30_999
    });
    assert.equal(submitted.revision, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM round_scores")).rows[0].n, 0);
    assert.deepEqual(await settleDueRounds(pool, 31_000), [round.id]);
    const score = (await pool.query(`SELECT points,detail_json FROM round_scores
      WHERE game_id=$1 AND player_id=$2`, [game.id, player.playerId])).rows[0];
    assert.equal(score.points, 32);
    assert.deepEqual(Object.values(score.detail_json).sort((a, b) => a - b), [5, 7, 10, 10]);
    const revealed = await getPublicRound(pool, game.id, round.id);
    assert.deepEqual(revealed.questions[1].answerRule.correctOptions, [0, 2]);
    assert.deepEqual(revealed.questions[2].answerRule.accepted, ["ＡBC", "Ada"]);
    assert.equal(JSON.stringify(revealed).includes("我的游戏感受很好"), false);
  } finally {
    await close();
  }
});

test("wrong game questions, duplicate multiselect values and overlong text cannot be submitted", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const { game, round, questions, owner } = await preparedFourTypes(pool);
    const other = await createGame(pool, owner.id, { slug: "foreign-quiz", title: "Other" });
    const foreignRound = await saveRound(pool, other.id, owner.id, {
      expectedVersion: 1, position: 1, title: "Other", durationMs: 30_000,
      questions: [{ position: 1, kind: "choice", prompt: "Foreign?",
        options: ["A", "B"], correctOption: 1, points: 7 }]
    });
    await publishFrozen(pool, other.id, owner.id);
    const foreignId = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
      [other.id])).rows[0].id;
    await startRound(pool, other.id, foreignRound.id, owner.id, 1000);
    const player = await registerPlayer(pool, game.id, {
      displayName: "Player", password: "player-password-1"
    });
    for (const answers of [
      { [foreignId]: 1 },
      { [questions[1].id]: [0, 0] },
      { [questions[2].id]: "甲".repeat(121) },
      { [questions[3].id]: "😀".repeat(121) }
    ]) {
      await assert.rejects(submitAnswers(pool, {
        gameId: game.id, playerId: player.playerId, roundId: round.id,
        answers, requestKey: randomUUID(), receivedAt: 30_999
      }), (error) => error.status === 400);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE game_id=$1",
      [game.id])).rows[0].n, 0);
  } finally {
    await close();
  }
});
