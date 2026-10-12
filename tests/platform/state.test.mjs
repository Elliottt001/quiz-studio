import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { startRound, submitAnswers, settleDueRounds } from "../../src/platform/quiz/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { publicState } from "../../src/platform/quiz/state.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("public state changes only on manual start and settlement without disclosing private quiz data", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const game = await createGame(pool, owner.id, { slug: "state-night", title: "状态游戏" });
  await assert.rejects(publicState(pool, game.slug, 1000), (error) => error.status === 404);
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: 1, position: 1, title: "Round", durationMs: 30_000,
    questions: [{ position: 1, kind: "exact", prompt: "秘密答案?",
      answerRule: { accepted: ["私密答案"] }, points: 7 }]
  });
  await publishFrozen(pool, game.id, owner.id);
  const player = await registerPlayer(pool, game.id, {
    displayName: "公开昵称", password: "player-password-1"
  });
  let now = 1000;
  const app = buildPlatformApp({ pool, clock: () => now, autoSettle: false });
  const base = await app.listen(0);
  try {
    const prepared = await publicState(pool, game.slug, now);
    assert.equal(prepared.rounds[0].status, "prepared");
    assert.equal(prepared.rounds[0].questionCount, 1);
    assert.equal(prepared.serverTime, now);
    now = 100_000;
    assert.equal((await publicState(pool, game.slug, now)).rounds[0].status, "prepared");
    await startRound(pool, game.id, round.id, owner.id, 100_000);
    const active = await (await fetch(base + `/v2/games/${game.slug}/state`)).json();
    assert.equal(active.rounds[0].status, "open");
    assert.equal(active.rounds[0].deadlineAt, 130_000);
    assert.equal(active.rounds[0].questionCount, 1);
    assert.equal(JSON.stringify(active).includes("私密答案"), false);
    assert.equal(JSON.stringify(active).includes("player-password"), false);
    const questionId = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
      [game.id])).rows[0].id;
    await submitAnswers(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: { [questionId]: "私密答案" }, requestKey: "one", receivedAt: 129_999
    });
    now = 130_000;
    await settleDueRounds(pool, now);
    const published = await (await fetch(base + `/v2/games/${game.slug}/state`)).json();
    assert.equal(published.rounds[0].status, "published");
    assert.equal(published.rounds[0].submissionCount, 1);
    assert.equal(JSON.stringify(published).includes("私密答案"), false);
    assert.equal(JSON.stringify(published).includes("公开昵称"), false);
  } finally {
    await app.close();
    await close();
  }
});
