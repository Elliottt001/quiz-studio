import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveDetails } from "../../src/platform/games/editor.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { registerPlayer } from "../../src/platform/players/repository.mjs";
import { validateProfile } from "../../src/platform/players/profile.mjs";
import { buildPlatformApp } from "../../src/platform/http/app.mjs";
import { newPlatformFixture } from "./helpers.mjs";

const teamField = {
  key: "team", label: "队伍", type: "select", required: true,
  options: ["甲队", "乙队"]
};

async function publish(pool, ownerId, slug, fields) {
  const game = await createGame(pool, ownerId, { slug, title: slug });
  const detail = await saveDetails(pool, game.id, ownerId, {
    expectedVersion: 1, title: slug, description: "欢迎填写",
    fields, leaderboard: true
  });
  await saveRound(pool, game.id, ownerId, {
    expectedVersion: detail.version, position: 1, title: "问题",
    durationMs: 30_000,
    questions: [{ position: 1, kind: "choice", prompt: "Ready?",
      options: ["No", "Yes"], correctOption: 1, points: 7 }]
  });
  await publishFrozen(pool, game.id, ownerId);
  return game;
}

test("custom registration validates only the published game's own fields", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    assert.deepEqual(validateProfile([teamField], { team: "乙队" }), { team: "乙队" });
    assert.throws(() => validateProfile([teamField], { team: "丙队" }),
      (error) => error.status === 400 && error.path === "profile.team");
    const owner = await createOrganizer(pool, {
      login: "owner", password: "owner-password-1"
    });
    const teamGame = await publish(pool, owner.id, "team-night", [teamField]);
    const noteGame = await publish(pool, owner.id, "note-night", [{
      key: "note", label: "说明", type: "text", required: false,
      minLength: 0, maxLength: 120
    }]);
    const account = await registerPlayer(pool, teamGame.id, {
      displayName: "同名玩家", password: "player-password-1",
      profile: { team: "乙队" }
    });
    assert.equal((await pool.query(`SELECT profile_json FROM players
      WHERE game_id=$1 AND id=$2`, [teamGame.id, account.playerId])).rows[0].profile_json.team,
    "乙队");
    for (const profile of [{}, { team: "丙队" }, { team: "甲队", note: "跨场资料" },
      { team: "甲队", unknown: "x" }]) {
      await assert.rejects(registerPlayer(pool, teamGame.id, {
        displayName: "非法", password: "player-password-2", profile
      }), (error) => error.status === 400);
    }
    await assert.rejects(registerPlayer(pool, noteGame.id, {
      displayName: "太长", password: "player-password-3", profile: { note: "😀".repeat(121) }
    }), (error) => error.status === 400);
    const other = await registerPlayer(pool, noteGame.id, {
      displayName: "同名玩家", password: "player-password-4",
      profile: { note: "不同场" }
    });
    assert.notEqual(account.playerId, other.playerId);
  } finally {
    await close();
  }
});

test("public registration and rankings hide profiles; operator sees only own game's players", async () => {
  const { pool, close } = await newPlatformFixture();
  const owner = await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
  const operator = await createOrganizer(pool, {
    login: "operator", password: "operator-password-1"
  });
  const game = await publish(pool, owner.id, "private-night", [teamField]);
  const otherGame = await publish(pool, owner.id, "other-night", []);
  await pool.query(`INSERT INTO game_members(game_id,organizer_id,role)
    VALUES($1,$2,'operator')`, [game.id, operator.id]);
  const account = await registerPlayer(pool, game.id, {
    displayName: "公众昵称", password: "player-password-1", profile: { team: "甲队" }
  });
  await registerPlayer(pool, otherGame.id, {
    displayName: "另一位", password: "player-password-2"
  });
  const app = buildPlatformApp({ pool, publicOrigin: "https://quiz.example" });
  const base = await app.listen(0);
  try {
    const registration = await (await fetch(base + `/v2/games/${game.slug}/registration`)).json();
    assert.deepEqual(registration.fields, [teamField]);
    assert.equal(JSON.stringify(registration).includes("公众昵称"), false);
    const leaderboard = await (await fetch(base + `/v2/games/${game.slug}/standings`)).json();
    assert.equal(leaderboard.players[0].displayName, "公众昵称");
    assert.equal(JSON.stringify(leaderboard).includes("甲队"), false);
    assert.equal((await fetch(base + `/v2/games/${game.id}/players`)).status, 401);
    const login = await fetch(base + "/v2/auth/login", {
      method: "POST", headers: { origin: "https://quiz.example",
        "x-quiz-action": "1", "content-type": "application/json" },
      body: JSON.stringify({ login: "operator", password: "operator-password-1" })
    });
    const cookie = login.headers.get("set-cookie");
    const privateList = await (await fetch(base + `/v2/games/${game.id}/players`, {
      headers: { cookie }
    })).json();
    assert.equal(privateList.players[0].profile.team, "甲队");
    assert.equal(privateList.players[0].id, account.playerId);
    assert.equal(JSON.stringify(privateList).includes("password_hash"), false);
    assert.equal((await fetch(base + `/v2/games/${otherGame.id}/players`, {
      headers: { cookie }
    })).status, 404);
  } finally {
    await app.close();
    await close();
  }
});
