import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { getEditor } from "../../src/platform/games/editor.mjs";
import { createRound, publishGame, startRound } from "../../src/platform/quiz/repository.mjs";
import {
  saveRound, deleteRound, reorderRounds, publishFrozen
} from "../../src/platform/quiz/editor.mjs";
import { newPlatformFixture } from "./helpers.mjs";

const exact = (prompt = "Name?") => ({
  position: 1, kind: "exact", prompt, points: 7,
  answerRule: { accepted: ["Ada"] }
});
const roundInput = (expectedVersion, position, title) => ({
  expectedVersion, position, title, durationMs: 90_000, questions: [exact()]
});

test("round edits, deletion and reorder create complete contiguous version snapshots", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const game = await createGame(pool, owner.id, { slug: "version-night", title: "Quiz" });
    const first = await saveRound(pool, game.id, owner.id, roundInput(1, 1, "First"));
    assert.equal(first.version, 2);
    const second = await saveRound(pool, game.id, owner.id, roundInput(2, 2, "Second"));
    const third = await saveRound(pool, game.id, owner.id, roundInput(3, 3, "Third"));
    const edited = await saveRound(pool, game.id, owner.id, {
      roundId: first.id, expectedVersion: 4, position: 1, title: "First edited",
      durationMs: 120_000, questions: [exact("Who founded it?")]
    });
    assert.equal(edited.id, first.id);
    assert.equal(edited.version, 5);
    await assert.rejects(saveRound(pool, game.id, owner.id, {
      roundId: first.id, expectedVersion: 4, position: 1, title: "Old tab",
      durationMs: 120_000, questions: [exact("Wrong edit")]
    }), (error) => error.status === 409 && error.details.currentVersion === 5);
    assert.equal((await getEditor(pool, game.id, owner.id)).rounds[0].questions[0].prompt,
      "Who founded it?");
    const moved = await reorderRounds(pool, game.id, owner.id, {
      expectedVersion: 5, roundIds: [third.id, first.id, second.id]
    });
    assert.equal(moved.version, 6);
    const deleted = await deleteRound(pool, game.id, second.id, owner.id, 6);
    assert.equal(deleted.version, 7);
    const snapshot = await getEditor(pool, game.id, owner.id);
    assert.deepEqual(snapshot.rounds.map((round) => [round.id, round.position]),
      [[third.id, 1], [first.id, 2]]);
    assert.equal(snapshot.rounds[1].questions[0].prompt, "Who founded it?");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM game_versions WHERE game_id=$1",
      [game.id])).rows[0].n, 7);
    assert.equal((await pool.query(`SELECT count(DISTINCT config_version)::int AS n FROM rounds
      WHERE game_id=$1`, [game.id])).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT config_json FROM game_versions
      WHERE game_id=$1 AND version=7`, [game.id])).rows[0].config_json.rounds.length, 2);
  } finally {
    await close();
  }
});

test("publish freezes one version, retries do not duplicate it, and oversized answers are rejected", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const game = await createGame(pool, owner.id, { slug: "publish-night", title: "Quiz" });
    const round = await saveRound(pool, game.id, owner.id, roundInput(1, 1, "Round"));
    const attempts = await Promise.all([
      publishFrozen(pool, game.id, owner.id),
      publishFrozen(pool, game.id, owner.id)
    ]);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.deepEqual(attempts[0], {
      gameId: game.id, slug: game.slug, version: 2, status: "published"
    });
    assert.equal((await pool.query("SELECT published_version FROM games WHERE id=$1",
      [game.id])).rows[0].published_version, 2);
    await assert.rejects(saveRound(pool, game.id, owner.id, {
      roundId: round.id, ...roundInput(2, 1, "Late")
    }), (error) => error.status === 409);
    await assert.rejects(deleteRound(pool, game.id, round.id, owner.id, 2),
      (error) => error.status === 409);
    const started = await startRound(pool, game.id, round.id, owner.id, 1000);
    assert.equal(started.deadlineAt, 91_000);

    const tooLarge = await createGame(pool, owner.id, {
      slug: "oversized-night", title: "Too many long answers"
    });
    await saveRound(pool, tooLarge.id, owner.id, {
      expectedVersion: 1, position: 1, title: "Long", durationMs: 60_000,
      questions: Array.from({ length: 100 }, (_, index) => ({
        position: index + 1, kind: "length", prompt: `感受 ${index + 1}`,
        points: 10, answerRule: { minLength: 1, maxLength: 120 }
      }))
    });
    await assert.rejects(publishFrozen(pool, tooLarge.id, owner.id),
      (error) => error.status === 400 && error.path === "round.questions");
    assert.equal((await pool.query("SELECT status FROM games WHERE id=$1",
      [tooLarge.id])).rows[0].status, "draft");
  } finally {
    await close();
  }
});

test("the editor sees answers; unauthenticated public views do not", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const outsider = await createOrganizer(pool, { login: "outsider", password: "outsider-password-1" });
  const game = await createGame(pool, owner.id, { slug: "preview-night", title: "Preview" });
  const round = await saveRound(pool, game.id, owner.id, roundInput(1, 1, "Preview round"));
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: "POST", headers: { origin: "https://quiz.example", "x-quiz-action": "1",
      "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const ownerCookie = (await post("/v2/auth/login", {
      login: owner.login, password: "owner-password-1"
    })).headers.get("set-cookie");
    const outsiderCookie = (await post("/v2/auth/login", {
      login: outsider.login, password: "outsider-password-1"
    })).headers.get("set-cookie");
    assert.equal((await fetch(base + `/v2/games/${game.id}/editor`)).status, 401);
    assert.equal((await fetch(base + `/v2/games/${game.id}/editor`, {
      headers: { cookie: outsiderCookie }
    })).status, 404);
    const editor = await (await fetch(base + `/v2/games/${game.id}/editor`, {
      headers: { cookie: ownerCookie }
    })).json();
    assert.deepEqual(editor.rounds[0].questions[0].answerRule, { accepted: ["Ada"] });
    assert.equal((await fetch(base + `/v2/games/${game.slug}/rounds/${round.id}`)).status, 404);
    assert.equal((await post(`/v2/games/${game.id}/publish`, {}, ownerCookie)).status, 200);
    const before = await (await fetch(base + `/v2/games/${game.slug}/rounds/${round.id}`)).json();
    assert.deepEqual(before.questions, []);
    assert.equal((await post(`/v2/games/${game.id}/rounds/${round.id}/start`, {},
      ownerCookie)).status, 200);
    const active = await (await fetch(base + `/v2/games/${game.slug}/rounds/${round.id}`)).json();
    assert.equal(JSON.stringify(active).includes("Ada"), false);
  } finally {
    await app.close();
    await close();
  }
});

test("existing choice-only create and publish functions keep their response and frozen version", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const game = await createGame(pool, owner.id, { slug: "old-api-night", title: "Old" });
    const round = await createRound(pool, game.id, owner.id, {
      position: 1, title: "Choice", durationMs: 30_000,
      questions: [{ position: 1, kind: "choice", prompt: "Correct?",
        options: ["No", "Yes"], correctOption: 1, points: 7 }]
    });
    assert.equal(round.status, "prepared");
    const published = await publishGame(pool, game.id, owner.id);
    assert.deepEqual(published, { id: game.id, status: "published" });
    assert.equal((await getEditor(pool, game.id, owner.id)).rounds[0].questions.length, 1);
    assert.equal((await pool.query("SELECT current_version,published_version FROM games WHERE id=$1",
      [game.id])).rows[0].published_version,
    (await getEditor(pool, game.id, owner.id)).version);
  } finally {
    await close();
  }
});
