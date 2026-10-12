import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { settleDueRounds } from "../../src/platform/quiz/repository.mjs";
import { buildPlatform } from "../../scripts/build-platform.mjs";
import { verifyPlatform } from "../../scripts/verify-platform.mjs";
import { newPlatformFixture } from "./helpers.mjs";

const post = async (base, path, body, cookie) => {
  const response = await fetch(base + path, {
    method: "POST", headers: {
      "x-quiz-action": "1", "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    }, body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${path}: ${payload.error ?? response.status}`);
  return { body: payload, cookie: response.headers.get("set-cookie") };
};

test("probe rejects a Pages-only landing and verifies a real multi-game API with scoped scores", async () => {
  const { pool, close } = await newPlatformFixture();
  const assets = mkdtempSync(join(tmpdir(), "quiz-release-"));
  buildPlatform(resolve("public/platform"), assets);
  const app = buildPlatformApp({ pool, staticDir: assets, autoSettle: false });
  const base = await app.listen(0);
  const fake = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>Coming soon</body></html>");
  });
  await new Promise((resolveListen) => fake.listen(0, "127.0.0.1", resolveListen));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  try {
    const ownerA = await createOrganizer(pool, {
      login: "owner-a", password: "owner-password-1"
    });
    const ownerB = await createOrganizer(pool, {
      login: "owner-b", password: "owner-password-2"
    });
    const loginA = await post(base, "/v2/auth/login", {
      login: ownerA.login, password: "owner-password-1"
    });
    const loginB = await post(base, "/v2/auth/login", {
      login: ownerB.login, password: "owner-password-2"
    });
    const games = [];
    for (const [index, cookie] of [loginA.cookie, loginB.cookie].entries()) {
      const created = await post(base, "/v2/games", {
        slug: `quiz-${index + 1}`, title: `Game ${index + 1}`
      }, cookie);
      const game = created.body;
      const round = await post(base, `/v2/games/${game.id}/rounds`, {
        expectedVersion: 1, position: 1, title: "Round", durationMs: 30_000,
        questions: [{ position: 1, kind: "choice", prompt: "Ready?",
          options: ["No", "Yes"], answerRule: { correctOption: 1 }, points: 7 }]
      }, cookie);
      await post(base, `/v2/games/${game.id}/publish`, {}, cookie);
      games.push({ game, round: round.body, cookie });
    }
    assert.deepEqual(await verifyPlatform(base, games[0].game.slug),
      { health: true, home: true, organizer: true, player: true, state: true });
    const staticOnly = await verifyPlatform(fakeBase, "quiz-1");
    assert.equal(staticOnly.health, false);
    assert.equal(staticOnly.state, false);
    const questionIds = [];
    for (const entry of games) {
      const details = await (await fetch(`${base}/v2/games/${entry.game.slug}/state`)).json();
      assert.equal(details.rounds[0].status, "prepared");
      const question = (await pool.query("SELECT id FROM questions WHERE game_id=$1",
        [entry.game.id])).rows[0].id;
      questionIds.push(question);
      await post(base, `/v2/games/${entry.game.id}/rounds/${entry.round.id}/start`,
        {}, entry.cookie);
      for (let i = 0; i < (entry === games[0] ? 2 : 1); i++) {
        const registered = await post(base, `/v2/games/${entry.game.slug}/players`, {
          displayName: `Player ${i}`, password: "player-password-1"
        });
        await post(base, `/v2/games/${entry.game.slug}/rounds/${entry.round.id}/submit`, {
          answers: { [question]: 1 }, requestKey: `player-${i}`
        }, registered.cookie);
      }
    }
    await settleDueRounds(pool, Date.now() + 31_000);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM games")).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM round_scores
      WHERE game_id=$1`, [games[0].game.id])).rows[0].n, 2);
    await post(base, `/v2/games/${games[0].game.id}/questions/${questionIds[0]}/void`,
      { reason: "题目依据错误" }, games[0].cookie);
    assert.deepEqual((await pool.query("SELECT points FROM round_scores WHERE game_id=$1",
      [games[0].game.id])).rows.map((row) => row.points), [0, 0]);
    assert.equal((await pool.query("SELECT points FROM round_scores WHERE game_id=$1",
      [games[1].game.id])).rows[0].points, 7);
  } finally {
    await app.close();
    await new Promise((resolveClose) => fake.close(resolveClose));
    await close();
    rmSync(assets, { recursive: true, force: true });
  }
});
