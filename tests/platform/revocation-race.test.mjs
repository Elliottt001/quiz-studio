import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { inviteOperator, removeOperator } from "../../src/platform/games/members.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { issueRecovery } from "../../src/platform/players/recovery.mjs";
import { startRound } from "../../src/platform/quiz/repository.mjs";
import { newPlatformFixture } from "./helpers.mjs";

function delayedPool(pool) {
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  return {
    waiting,
    release,
    query: (...args) => pool.query(...args),
    async connect() {
      entered();
      await barrier;
      return pool.connect();
    }
  };
}

test("a revoked operator cannot issue recovery codes or start a round while queued for DB", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const operator = await createOrganizer(pool, {
      login: "operator", password: "operator-password-1"
    });
    const game = await createGame(pool, owner.id, { slug: "revocation", title: "Quiz" });
    const round = await saveRound(pool, game.id, owner.id, {
      expectedVersion: 1, position: 1, title: "Round", durationMs: 30_000,
      questions: [{ position: 1, kind: "choice", prompt: "Ready?",
        options: ["No", "Yes"], answerRule: { correctOption: 1 }, points: 7 }]
    });
    await publishFrozen(pool, game.id, owner.id);
    const player = await registerPlayer(pool, game.id, {
      displayName: "Player", password: "player-password-1"
    });
    const now = Date.now();
    await inviteOperator(pool, game.id, owner.id, operator.login, now);
    const recoveryGate = delayedPool(pool);
    const recovery = issueRecovery(recoveryGate, game.id, player.playerId, operator.id, now + 1);
    await recoveryGate.waiting;
    await removeOperator(pool, game.id, owner.id, operator.id, now + 2);
    recoveryGate.release();
    await assert.rejects(recovery, (error) => error.status === 404);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM recovery_codes")).rows[0].n, 0);

    await inviteOperator(pool, game.id, owner.id, operator.login, now + 3);
    const roundGate = delayedPool(pool);
    const starting = startRound(roundGate, game.id, round.id, operator.id, now + 4);
    await roundGate.waiting;
    await removeOperator(pool, game.id, owner.id, operator.id, now + 5);
    roundGate.release();
    await assert.rejects(starting, (error) => error.status === 404);
    assert.equal((await pool.query("SELECT status FROM rounds WHERE game_id=$1",
      [game.id])).rows[0].status, "prepared");
  } finally {
    await close();
  }
});
