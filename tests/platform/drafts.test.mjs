import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import {
  submitAnswers, settleDueRounds
} from "../../src/platform/quiz/repository.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveDraft } from "../../src/platform/players/drafts.mjs";
import { newPlatformFixture } from "./helpers.mjs";
import { preparedFourTypes } from "./quiz-fixtures.mjs";

test("a draft is private and never scores; a later draft does not override a confirmed answer", async () => {
  const { pool, close } = await newPlatformFixture();
  const { game, round, questions, owner } = await preparedFourTypes(pool);
  const player = await registerPlayer(pool, game.id, {
    displayName: "Player", password: "player-password-1"
  });
  const cookie = `game_session_${game.slug}=${player.sessionToken}`;
  let now = 30_999;
  const app = buildPlatformApp({ pool, clock: () => now, autoSettle: false });
  const base = await app.listen(0);
  try {
    const first = { [questions[0].id]: 1 };
    const saved = await saveDraft(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: first, receivedAt: now
    });
    assert.equal(saved.savedAt, now);
    const draftPath = `/v2/games/${game.slug}/rounds/${round.id}/draft`;
    const saveHttp = (headers) => fetch(base + draftPath, {
      method: "PUT", headers: {
        "x-quiz-action": "1", "content-type": "application/json", ...headers
      }, body: JSON.stringify({ answers: first })
    });
    assert.equal((await saveHttp({})).status, 401);
    assert.equal((await saveHttp({ cookie })).status, 200);
    const minePath = `/v2/games/${game.slug}/rounds/${round.id}/my`;
    assert.equal((await fetch(base + minePath)).status, 401);
    const draftOnly = await (await fetch(base + minePath, { headers: { cookie } })).json();
    assert.deepEqual(draftOnly.draft.answers, first);
    assert.equal(draftOnly.submission, null);
    assert.equal(draftOnly.score, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM round_scores")).rows[0].n, 0);
    const receipt = await submitAnswers(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: first, requestKey: "confirmed", receivedAt: now
    });
    await saveDraft(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: { [questions[0].id]: 0 }, receivedAt: now
    });
    const afterEdit = await (await fetch(base + minePath, { headers: { cookie } })).json();
    assert.deepEqual(afterEdit.draft.answers, { [questions[0].id]: 0 });
    assert.deepEqual(afterEdit.submission.answers, first);
    assert.equal(afterEdit.submission.id, receipt.id);
    now = 31_000;
    await assert.rejects(saveDraft(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: first, receivedAt: now
    }), (error) => error.status === 409);
    assert.deepEqual(await submitAnswers(pool, {
      gameId: game.id, playerId: player.playerId, roundId: round.id,
      answers: first, requestKey: "confirmed", receivedAt: now
    }), receipt);
    await settleDueRounds(pool, now);
    const published = await (await fetch(base + minePath, { headers: { cookie } })).json();
    assert.equal(published.score, 7);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM round_scores")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM drafts")).rows[0].n, 1);
    const otherGame = await createGame(pool, owner.id, {
      slug: "other-game", title: "Another game"
    });
    await assert.rejects(saveDraft(pool, {
      gameId: otherGame.id, playerId: player.playerId, roundId: round.id,
      answers: first, receivedAt: 30_999
    }), (error) => error.status === 401);
  } finally {
    await app.close();
    await close();
  }
});
