import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import {
  startRound, submitAnswers, settleDueRounds, getPublicRound
} from "../../src/platform/quiz/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { voidQuestion, rescoreRound } from "../../src/platform/quiz/corrections.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { withTransaction } from "../../src/platform/db/pool.mjs";
import { newPlatformFixture } from "./helpers.mjs";

async function scoredGame(pool, owner, slug, playerCount) {
  const game = await createGame(pool, owner.id, { slug, title: slug });
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: 1, position: 1, title: "Round", durationMs: 30_000,
    questions: [{ position: 1, kind: "choice", prompt: "正确选项?",
      options: ["错误", "正确"], answerRule: { correctOption: 1 }, points: 7 }]
  });
  await publishFrozen(pool, game.id, owner.id);
  const questionId = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
    [game.id])).rows[0].id;
  const players = [];
  for (let index = 0; index < playerCount; index++) {
    players.push(await registerPlayer(pool, game.id, {
      displayName: `玩家${index + 1}`, password: `player-password-${index + 1}`
    }));
  }
  await startRound(pool, game.id, round.id, owner.id, 1000);
  for (const [index, player] of players.entries()) {
    await submitAnswers(pool, {
      gameId: game.id, roundId: round.id, playerId: player.playerId,
      answers: { [questionId]: 1 }, requestKey: `submit-${index}`, receivedAt: 30_999
    });
  }
  await settleDueRounds(pool, 31_000);
  return { game, round, questionId, players };
}

test("voiding one published question rescales every local player without changing another game", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const ownerA = await createOrganizer(pool, {
      login: "owner-a", password: "owner-password-1"
    });
    const ownerB = await createOrganizer(pool, {
      login: "owner-b", password: "owner-password-2"
    });
    const operator = await createOrganizer(pool, {
      login: "operator", password: "operator-password-1"
    });
    const a = await scoredGame(pool, ownerA, "first-game", 2);
    const b = await scoredGame(pool, ownerB, "second-game", 1);
    await pool.query(`INSERT INTO game_members(game_id,organizer_id,role)
      VALUES($1,$2,'operator')`, [a.game.id, operator.id]);
    assert.deepEqual((await pool.query(`SELECT points FROM round_scores WHERE game_id=$1`,
      [a.game.id])).rows.map((row) => row.points), [7, 7]);
    await assert.rejects(voidQuestion(pool, a.game.id, a.questionId, operator.id,
      "操作员不能改分", 31_100), (error) => error.status === 404);
    await assert.rejects(voidQuestion(pool, b.game.id, a.questionId, ownerB.id,
      "跨游戏尝试", 31_100), (error) => error.status === 404);
    await assert.rejects(voidQuestion(pool, a.game.id, a.questionId, ownerA.id,
      "", 31_100), (error) => error.status === 400);
    const result = await voidQuestion(pool, a.game.id, a.questionId, ownerA.id,
      "答案依据错误", 31_100);
    assert.deepEqual(result, { questionId: a.questionId, roundId: a.round.id });
    assert.deepEqual((await pool.query(`SELECT points FROM round_scores WHERE game_id=$1`,
      [a.game.id])).rows.map((row) => row.points), [0, 0]);
    assert.equal((await pool.query(`SELECT points FROM round_scores WHERE game_id=$1`,
      [b.game.id])).rows[0].points, 7);
    await withTransaction(pool, (client) => rescoreRound(client, a.game.id, a.round.id));
    assert.equal((await pool.query(`SELECT SUM(points)::int AS score FROM round_scores
      WHERE game_id=$1`, [a.game.id])).rows[0].score, 0);
    assert.equal((await pool.query("SELECT correct_option FROM questions WHERE game_id=$1",
      [a.game.id])).rows[0].correct_option, 1);
    assert.equal((await getPublicRound(pool, a.game.id, a.round.id)).questions[0].voided, true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE game_id=$1",
      [a.game.id])).rows[0].n, 2);
    const audit = (await pool.query(`SELECT actor_id,details_json FROM audit_events
      WHERE game_id=$1 AND kind='question_voided'`, [a.game.id])).rows[0];
    assert.equal(audit.actor_id, ownerA.id);
    assert.equal(audit.details_json.reason, "答案依据错误");
    await assert.rejects(voidQuestion(pool, a.game.id, a.questionId, ownerA.id,
      "重复作废", 31_101), (error) => error.status === 409);
  } finally {
    await close();
  }
});

test("void API is owner-only and does not alter an open round", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const game = await createGame(pool, owner.id, { slug: "open-game", title: "Open" });
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: 1, position: 1, title: "Round", durationMs: 30_000,
    questions: [{ position: 1, kind: "choice", prompt: "Right?",
      options: ["No", "Yes"], answerRule: { correctOption: 1 }, points: 7 }]
  });
  await publishFrozen(pool, game.id, owner.id);
  const questionId = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
    [game.id])).rows[0].id;
  await startRound(pool, game.id, round.id, owner.id, 1000);
  await assert.rejects(voidQuestion(pool, game.id, questionId, owner.id,
    "还没收卷", 10_000), (error) => error.status === 409);
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example", autoSettle: false });
  const base = await app.listen(0);
  try {
    const login = await fetch(base + "/v2/auth/login", {
      method: "POST", headers: { origin: "https://quiz.example",
        "x-quiz-action": "1", "content-type": "application/json" },
      body: JSON.stringify({ login: owner.login, password: "owner-password-1" })
    });
    assert.equal(login.status, 200);
    const response = await fetch(base + `/v2/games/${game.id}/questions/${questionId}/void`, {
      method: "POST", headers: { origin: "https://quiz.example",
        "x-quiz-action": "1", "content-type": "application/json",
        cookie: login.headers.get("set-cookie") },
      body: JSON.stringify({ reason: "还没收卷" })
    });
    assert.equal(response.status, 409);
  } finally {
    await app.close();
    await close();
  }
});
