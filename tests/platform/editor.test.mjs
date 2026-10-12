import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { createRound, publishGame } from "../../src/platform/quiz/repository.mjs";
import { getEditor, saveDetails } from "../../src/platform/games/editor.mjs";
import { newPlatformFixture } from "./helpers.mjs";

const details = (version, title) => ({
  expectedVersion: version,
  title,
  description: "欢迎一起探索",
  leaderboard: true,
  fields: [
    { key: "team", type: "select", label: "队伍", required: true,
      options: ["甲队", "乙队"] },
    { key: "note", type: "text", label: "备注", required: false,
      minLength: 0, maxLength: 40, help: "选填" }
  ]
});

test("a blank game saves versioned fields without losing a competing editor's data", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const other = await createOrganizer(pool, { login: "other", password: "other-password-1" });
    const operator = await createOrganizer(pool, { login: "operator", password: "operator-password-1" });
    const game = await createGame(pool, owner.id, { slug: "editor-night", title: "初始" });
    await pool.query(`INSERT INTO game_members(game_id,organizer_id,role)
      VALUES($1,$2,'operator')`, [game.id, operator.id]);
    const blank = await getEditor(pool, game.id, owner.id);
    assert.equal(blank.version, 1);
    assert.deepEqual(blank.fields, []);
    assert.deepEqual(blank.rounds, []);
    assert.equal((await getEditor(pool, game.id, operator.id)).role, "operator");
    await assert.rejects(getEditor(pool, game.id, other.id), (error) => error.status === 404);
    await assert.rejects(saveDetails(pool, game.id, operator.id, details(1, "禁止")), (error) =>
      error.status === 404);

    const first = await saveDetails(pool, game.id, owner.id, details(1, "科学之夜"));
    assert.deepEqual(first, { version: 2 });
    const stored = await getEditor(pool, game.id, owner.id);
    assert.equal(stored.game.title, "科学之夜");
    assert.equal(stored.description, "欢迎一起探索");
    assert.equal(stored.fields[0].options[1], "乙队");
    const updates = await Promise.allSettled([
      saveDetails(pool, game.id, owner.id, details(2, "标签 A")),
      saveDetails(pool, game.id, owner.id, details(2, "标签 B"))
    ]);
    assert.equal(updates.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejected = updates.find((entry) => entry.status === "rejected").reason;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.details.currentVersion, 3);
    assert.equal((await getEditor(pool, game.id, owner.id)).version, 3);
    const snapshot = (await pool.query(`SELECT config_json FROM game_versions
      WHERE game_id=$1 AND version=3`, [game.id])).rows[0].config_json;
    assert.equal(snapshot.fields.length, 2);
    assert.equal(snapshot.title, (await getEditor(pool, game.id, owner.id)).game.title);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events
      WHERE game_id=$1 AND kind='details_saved'`, [game.id])).rows[0].n, 2);
  } finally {
    await close();
  }
});

test("draft field validation and HTTP version conflicts are scoped to the owner", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const operator = await createOrganizer(pool, { login: "operator", password: "operator-password-1" });
  const other = await createOrganizer(pool, { login: "other", password: "other-password-1" });
  const game = await createGame(pool, owner.id, { slug: "field-night", title: "Field" });
  await pool.query("INSERT INTO game_members(game_id,organizer_id,role) VALUES($1,$2,'operator')",
    [game.id, operator.id]);
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  const post = (path, body, cookie) => fetch(base + path, {
    method: path.endsWith("/details") ? "PATCH" : "POST",
    headers: { origin: "https://quiz.example", "x-quiz-action": "1",
      "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  const login = async (name, password) =>
    (await post("/v2/auth/login", { login: name, password })).headers.get("set-cookie");
  try {
    const own = await login("owner", "owner-password-1");
    const operate = await login("operator", "operator-password-1");
    const stranger = await login("other", "other-password-1");
    const path = `/v2/games/${game.id}`;
    assert.equal((await fetch(base + path + "/editor", { headers: { cookie: stranger } })).status, 404);
    assert.equal((await post(path + "/details", details(1, "禁止"), operate)).status, 404);
    const first = await post(path + "/details", details(1, "科学之夜"), own);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).version, 2);
    const stale = await post(path + "/details", details(1, "旧标签"), own);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).currentVersion, 2);
    const bad = details(2, "非法字段");
    bad.fields.push({ ...bad.fields[0] });
    const duplicate = await post(path + "/details", bad, own);
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).path, "fields[2].key");
    assert.equal((await getEditor(pool, game.id, owner.id)).version, 2);
    for (const invalid of [
      { fields: Array.from({ length: 13 }, (_, index) => ({
        key: `f${index}`, type: "text", label: `字段${index}`, required: false,
        minLength: 0, maxLength: 120
      })) },
      { fields: [{ key: "team", type: "select", label: "队伍", required: true,
        options: ["甲队", "甲队"] }] },
      { fields: [{ key: "team", type: "unknown", label: "队伍", required: true }] },
      { description: "字".repeat(2001) }
    ]) {
      const response = await post(path + "/details", { ...details(2, "错误"), ...invalid }, own);
      assert.equal(response.status, 400);
    }
  } finally {
    await app.close();
    await close();
  }
});

test("a published stage-one choice game remains readable but cannot be edited", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const game = await createGame(pool, owner.id, { slug: "published-choice", title: "Old choice" });
    await createRound(pool, game.id, owner.id, {
      position: 1, title: "Old round", durationMs: 30_000,
      questions: [{ position: 1, kind: "choice", prompt: "Yes?",
        options: ["No", "Yes"], correctOption: 1, points: 7 }]
    });
    await publishGame(pool, game.id, owner.id);
    const editor = await getEditor(pool, game.id, owner.id);
    assert.equal(editor.rounds.length, 1);
    assert.deepEqual(editor.rounds[0].questions[0].answerRule, { correctOption: 1 });
    await assert.rejects(saveDetails(pool, game.id, owner.id, details(1, "不能修改")), (error) =>
      error.status === 409);
  } finally {
    await close();
  }
});
