import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import {
  createRound, publishGame, startRound, settleDueRounds
} from "../../src/platform/quiz/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";
import { submitAnswers } from "../../src/platform/quiz/repository.mjs";
import { createPlatformPool } from "../../src/platform/db/pool.mjs";

test("HTTP admission before the deadline drains before scoring, without accepting cross-game cookies", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const games = [];
  for (let i = 1; i <= 2; i++) {
    const game = await createGame(pool, owner.id, { slug: `game-${i}`, title: `Game ${i}` });
    const round = await createRound(pool, game.id, owner.id, { position: 1, title: "Round",
      durationMs: 30_000, questions: [{ position: 1, kind: "choice", prompt: "Ready?",
        options: ["No", "Yes"], correctOption: 1, points: 7 }] });
    await publishGame(pool, game.id, owner.id);
    games.push({ game, round });
  }
  const player = await registerPlayer(pool, games[0].game.id, {
    displayName: "First", password: "player-password-1"
  });
  const cookie = `game_session_${games[0].game.slug}=${player.sessionToken}`;
  const q = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
    [games[0].game.id])).rows[0].id;
  await startRound(pool, games[0].game.id, games[0].round.id, owner.id, 1000);
  await startRound(pool, games[1].game.id, games[1].round.id, owner.id, 1000);
  let now = 30_999;
  let release;
  let attempted;
  const attemptedConnect = new Promise((resolve) => { attempted = resolve; });
  const blockedConnect = new Promise((resolve) => { release = resolve; });
  const queuedPool = {
    query: (...args) => pool.query(...args),
    async connect() {
      attempted();
      await blockedConnect;
      return pool.connect();
    }
  };
  const app = buildPlatformApp({ pool: queuedPool, clock: () => now,
    publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (slug, roundId, answers, requestKey) => fetch(
    `${base}/v2/games/${slug}/rounds/${roundId}/submit`,
    { method: "POST", headers: { origin: "https://quiz.example", cookie,
      "x-quiz-action": "1", "content-type": "application/json" },
    body: JSON.stringify({ answers, requestKey }) }
  );
  try {
    const cross = await post(games[1].game.slug, games[1].round.id,
      { [q]: 1 }, "foreign");
    assert.equal(cross.status, 401);
    const pending = post(games[0].game.slug, games[0].round.id, { [q]: 1 }, "on-time");
    await attemptedConnect;
    now = 31_000;
    assert.deepEqual(await settleDueRounds(pool, now,
      (slug, id) => app.pendingFor(slug, id)), [games[1].round.id]);
    release();
    const accepted = await pending;
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).submittedAt, 30_999);
    assert.deepEqual(await settleDueRounds(pool, now,
      (slug, id) => app.pendingFor(slug, id)), [games[0].round.id]);
    assert.equal((await post(games[0].game.slug, games[0].round.id, { [q]: 1 }, "late")).status, 409);
    const mine = await fetch(`${base}/v2/games/${games[0].game.slug}/rounds/${games[0].round.id}/my`,
      { headers: { cookie } });
    assert.equal((await mine.json()).score, 7);
    const board = await (await fetch(`${base}/v2/games/${games[0].game.slug}/standings`)).json();
    assert.equal(board.players[0].score, 7);
    assert.equal(board.players[0].displayName, "First");
  } finally {
    release();
    await app.close();
    await close();
  }
});

test("a new database pool retains confirmed scores and ties share a rank", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const game = await createGame(pool, owner.id, { slug: "quiz-night", title: "Quiz" });
  const round = await createRound(pool, game.id, owner.id, { position: 1, title: "Round",
    durationMs: 30_000, questions: [{ position: 1, kind: "choice", prompt: "Ready?",
      options: ["No", "Yes"], correctOption: 1, points: 7 }] });
  await publishGame(pool, game.id, owner.id);
  const players = await Promise.all(["A", "B"].map((displayName) =>
    registerPlayer(pool, game.id, { displayName, password: "player-password-1" })));
  const question = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
    [game.id])).rows[0].id;
  await startRound(pool, game.id, round.id, owner.id, 1000);
  await Promise.all(players.map((player, index) =>
    submitAnswers(pool, { gameId: game.id, roundId: round.id, playerId: player.playerId,
      answers: { [question]: 1 }, requestKey: `submit-${index}`, receivedAt: 30_999 })));
  await settleDueRounds(pool, 31_000);
  const schema = (await pool.query("SHOW search_path")).rows[0].search_path;
  const reopened = createPlatformPool({ connectionString: process.env.TEST_DATABASE_URL,
    searchPath: schema });
  const app = buildPlatformApp({ pool: reopened });
  const base = await app.listen(0);
  try {
    assert.deepEqual(await settleDueRounds(reopened, 31_001), []);
    const board = await (await fetch(`${base}/v2/games/${game.slug}/standings`)).json();
    assert.deepEqual(board.players.map((p) => p.score), [7, 7]);
    assert.deepEqual(board.players.map((p) => p.rank), [1, 1]);
  } finally {
    await app.close();
    await reopened.end();
    await close();
  }
});
