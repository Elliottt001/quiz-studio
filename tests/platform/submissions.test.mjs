import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import {
  createRound, publishGame, startRound, submitAnswers, settleDueRounds
} from "../../src/platform/quiz/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";

async function prepared(pool, number) {
  const owner = await createOrganizer(pool, {
    login: `owner-${number}`, password: `owner-password-${number}`
  });
  const game = await createGame(pool, owner.id, {
    slug: `game-${number}`, title: `Game ${number}`
  });
  const round = await createRound(pool, game.id, owner.id, {
    position: 1, title: `Round ${number}`, durationMs: 30_000,
    questions: [{ position: 1, kind: "choice", prompt: "2+2?",
      options: ["3", "4"], correctOption: 1, points: 7 }]
  });
  await publishGame(pool, game.id, owner.id);
  const player = await registerPlayer(pool, game.id, {
    displayName: "Player", password: `player-password-${number}`
  });
  const question = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
    [game.id])).rows[0].id;
  await startRound(pool, game.id, round.id, owner.id, 1000);
  return { game, round, player, question };
}

test("five games persist independent idempotent receipts and score only the latest revision", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const games = [];
    for (let i = 1; i <= 5; i++) games.push(await prepared(pool, i));
    const receipts = await Promise.all(games.map(({ game, round, player, question }) =>
      submitAnswers(pool, { gameId: game.id, playerId: player.playerId, roundId: round.id,
        answers: { [question]: 1 }, requestKey: "same-key", receivedAt: 30_999 })));
    assert.equal(new Set(receipts.map((r) => r.id)).size, 5);
    const { game, round, player, question } = games[0];
    const input = { gameId: game.id, playerId: player.playerId, roundId: round.id };
    const original = await submitAnswers(pool, {
      ...input, answers: { [question]: 1 }, requestKey: "same-key", receivedAt: 31_000
    });
    assert.deepEqual(original, receipts[0]);
    await assert.rejects(submitAnswers(pool, {
      ...input, answers: { [question]: 0 }, requestKey: "same-key", receivedAt: 31_000
    }), (e) => e.status === 409);
    await assert.rejects(submitAnswers(pool, {
      ...input, answers: { other: 1 }, requestKey: "unknown", receivedAt: 30_999
    }), (e) => e.status === 400);
    await assert.rejects(submitAnswers(pool, {
      ...input, answers: { [question]: 2 }, requestKey: "bad-option", receivedAt: 30_999
    }), (e) => e.status === 400);
    await assert.rejects(submitAnswers(pool, {
      ...input, answers: { [question]: 1 }, requestKey: "late", receivedAt: 31_000
    }), (e) => e.status === 409);
    await assert.rejects(submitAnswers(pool, {
      gameId: games[1].game.id, playerId: player.playerId, roundId: games[1].round.id,
      answers: { [games[1].question]: 1 }, requestKey: "cross", receivedAt: 30_999
    }), (e) => e.status === 401);
    const concurrent = await Promise.all([
      submitAnswers(pool, { ...input, answers: { [question]: 0 },
        requestKey: "rev-2", receivedAt: 30_999 }),
      submitAnswers(pool, { ...input, answers: { [question]: 1 },
        requestKey: "rev-3", receivedAt: 30_999 })
    ]);
    assert.deepEqual(concurrent.map((r) => r.revision).sort(), [2, 3]);
    const settled = await settleDueRounds(pool, 31_000);
    assert.equal(settled.length, 5);
    assert.deepEqual(await settleDueRounds(pool, 31_001), []);
    const score = (await pool.query(`SELECT points FROM round_scores
      WHERE game_id=$1 AND player_id=$2`, [game.id, player.playerId])).rows[0].points;
    assert.equal(score, concurrent.find((r) => r.revision === 3).id === concurrent[0].id ? 0 : 7);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM round_scores
      WHERE game_id=$1 AND round_id=$2`, [game.id, round.id])).rows[0].n, 1);
  } finally {
    await close();
  }
});

test("a database failure cannot return a success receipt or consume a revision", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const { game, round, player, question } = await prepared(pool, 1);
    await pool.query(`CREATE FUNCTION reject_answer() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'forced database failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_answer_before_insert
      BEFORE INSERT ON submissions FOR EACH ROW EXECUTE FUNCTION reject_answer()`);
    const input = { gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: { [question]: 1 }, requestKey: "try", receivedAt: 30_999 };
    await assert.rejects(submitAnswers(pool, input), /forced database failure/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n, 0);
    await pool.query("DROP TRIGGER reject_answer_before_insert ON submissions");
    assert.equal((await submitAnswers(pool, input)).revision, 1);
  } finally {
    await close();
  }
});
