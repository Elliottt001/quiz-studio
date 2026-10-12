import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { getEditor } from "../../src/platform/games/editor.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { startRound } from "../../src/platform/quiz/repository.mjs";
import { inviteOperator, removeOperator } from "../../src/platform/games/members.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("operator invitation is scoped, idempotent and immediately revocable", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const operator = await createOrganizer(pool, {
    login: "operator", password: "operator-password-1"
  });
  const outsider = await createOrganizer(pool, {
    login: "outsider", password: "outsider-password-1"
  });
  const game = await createGame(pool, owner.id, { slug: "member-night", title: "Membership" });
  const other = await createGame(pool, outsider.id, { slug: "other-night", title: "Other" });
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: 1, position: 1, title: "Round", durationMs: 30_000,
    questions: [{ position: 1, kind: "choice", prompt: "Ready?",
      options: ["No", "Yes"], correctOption: 1, points: 7 }]
  });
  await publishFrozen(pool, game.id, owner.id);
  try {
    const first = await inviteOperator(pool, game.id, owner.id, operator.login, 1000);
    const second = await inviteOperator(pool, game.id, owner.id, operator.login, 1001);
    assert.deepEqual(first, second);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM game_members
      WHERE game_id=$1 AND role='operator'`, [game.id])).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events
      WHERE game_id=$1 AND kind='operator_invited'`, [game.id])).rows[0].n, 1);
    assert.equal((await getEditor(pool, game.id, operator.id)).role, "operator");
    await assert.rejects(inviteOperator(pool, other.id, owner.id, operator.login, 1002),
      (error) => error.status === 404);
    await assert.rejects(removeOperator(pool, game.id, owner.id, owner.id, 1002),
      (error) => error.status === 409);
    await removeOperator(pool, game.id, owner.id, operator.id, 1003);
    await assert.rejects(getEditor(pool, game.id, operator.id),
      (error) => error.status === 404);
    await assert.rejects(startRound(pool, game.id, round.id, operator.id, 1004),
      (error) => error.status === 404);

    const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
    const base = await app.listen(0);
    try {
      const login = await fetch(base + "/v2/auth/login", {
        method: "POST", headers: { origin: "https://quiz.example",
          "x-quiz-action": "1", "content-type": "application/json" },
        body: JSON.stringify({ login: owner.login, password: "owner-password-1" })
      });
      const member = await fetch(base + `/v2/games/${game.id}/members`, {
        method: "POST", headers: { origin: "https://quiz.example",
          "x-quiz-action": "1", "content-type": "application/json",
          cookie: login.headers.get("set-cookie") },
        body: JSON.stringify({ login: operator.login })
      });
      assert.equal(member.status, 200);
      const removed = await fetch(base + `/v2/games/${game.id}/members/${operator.id}`, {
        method: "DELETE", headers: { origin: "https://quiz.example",
          "x-quiz-action": "1", "content-type": "application/json",
          cookie: login.headers.get("set-cookie") },
        body: "{}"
      });
      assert.equal(removed.status, 200);
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});
