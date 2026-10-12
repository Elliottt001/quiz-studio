import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveDetails } from "../../src/platform/games/editor.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { startRound, submitAnswers, settleDueRounds } from "../../src/platform/quiz/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("a disabled public leaderboard hides identities but preserves the player's own score", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const game = await createGame(pool, owner.id, { slug: "private-board", title: "Quiz" });
  const details = await saveDetails(pool, game.id, owner.id, {
    expectedVersion: 1, title: "Quiz", description: "", fields: [], leaderboard: false
  });
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: details.version, position: 1, title: "Round", durationMs: 30_000,
    questions: [{ position: 1, kind: "choice", prompt: "Ready?",
      options: ["No", "Yes"], answerRule: { correctOption: 1 }, points: 7 }]
  });
  await publishFrozen(pool, game.id, owner.id);
  const question = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
    [game.id])).rows[0].id;
  const player = await registerPlayer(pool, game.id, {
    displayName: "不公开的玩家", password: "player-password-1"
  });
  await startRound(pool, game.id, round.id, owner.id, 1000);
  await submitAnswers(pool, {
    gameId: game.id, playerId: player.playerId, roundId: round.id,
    answers: { [question]: 1 }, requestKey: "one", receivedAt: 30_999
  });
  await settleDueRounds(pool, 31_000);
  const app = buildPlatformApp({ pool, autoSettle: false });
  const base = await app.listen(0);
  try {
    const publicBoard = await (await fetch(`${base}/v2/games/${game.slug}/standings`)).json();
    assert.deepEqual(publicBoard.players, []);
    assert.equal(publicBoard.enabled, false);
    assert.equal(JSON.stringify(publicBoard).includes("不公开的玩家"), false);
    const mine = await (await fetch(`${base}/v2/games/${game.slug}/rounds/${round.id}/my`, {
      headers: { cookie: `game_session_${game.slug}=${player.sessionToken}` }
    })).json();
    assert.equal(mine.score, 7);
  } finally {
    await app.close();
    await close();
  }
});
