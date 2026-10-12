import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool.mjs";
import { writeVersionSnapshot } from "../games/editor.mjs";
import { requireGameRole } from "../games/repository.mjs";
import { httpError } from "../http/errors.mjs";
import { maxAnswerBytes, validateQuestion } from "./rules.mjs";

async function lockDraft(client, gameId, expectedVersion) {
  const game = (await client.query(`SELECT id,slug,status,current_version FROM games
    WHERE id=$1 FOR UPDATE`, [gameId])).rows[0];
  if (!game) throw httpError(404, "游戏不存在");
  if (game.status !== "draft") throw httpError(409, "游戏已发布");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw httpError(400, "草稿版本无效", { path: "expectedVersion" });
  }
  if (game.current_version !== expectedVersion) {
    throw httpError(409, "草稿版本冲突", { currentVersion: game.current_version });
  }
  return game;
}

async function insertQuestions(client, gameId, roundId, questions) {
  for (const question of questions) {
    await client.query(`INSERT INTO questions
      (game_id,id,round_id,position,kind,prompt,options_json,correct_option,
       points,answer_rule_json)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb)`,
    [gameId, randomUUID(), roundId, question.position, question.kind, question.prompt,
      question.options ? JSON.stringify(question.options) : null,
      question.kind === "choice" ? question.answerRule.correctOption : null,
      question.points, JSON.stringify(question.answerRule)]);
  }
}

export async function bumpDraftVersion(client, gameId, previousVersion, actorId, kind, targetId, now) {
  const version = previousVersion + 1;
  await client.query(`INSERT INTO game_versions(game_id,version,config_json,created_at)
    VALUES($1,$2,'{}'::jsonb,$3)`, [gameId, version, now]);
  await client.query("UPDATE games SET current_version=$2 WHERE id=$1", [gameId, version]);
  await client.query("UPDATE rounds SET config_version=$2 WHERE game_id=$1",
    [gameId, version]);
  await writeVersionSnapshot(client, gameId, version, now);
  await client.query(`INSERT INTO audit_events
    (game_id,actor_id,kind,target_id,details_json,occurred_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
  [gameId, actorId, kind, targetId,
    JSON.stringify({ previousVersion, version }), now]);
  return version;
}

function validateRoundDraft(input) {
  if (!input || !Number.isInteger(input.position) || input.position < 1
    || typeof input.title !== "string" || !input.title.trim()
    || Array.from(input.title.trim()).length > 120
    || !Number.isInteger(input.durationMs) || input.durationMs < 30_000
    || input.durationMs > 3_600_000
    || !Array.isArray(input.questions) || input.questions.length < 1
    || input.questions.length > 100) {
    throw httpError(400, "轮次配置无效", { path: "round" });
  }
  return input.questions.map((question, index) => {
    if (question?.position !== index + 1) {
      throw httpError(400, "题号须从 1 连续排列", { path: `questions[${index}].position` });
    }
    return validateQuestion(question);
  });
}

export async function saveRound(pool, gameId, organizerId, input) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  const questions = validateRoundDraft(input);
  return withTransaction(pool, async (client) => {
    await lockDraft(client, gameId, input.expectedVersion);
    const current = (await client.query(`SELECT id,position FROM rounds
      WHERE game_id=$1 ORDER BY position`, [gameId])).rows;
    let roundId = input.roundId;
    if (roundId) {
      const existing = current.find((round) => round.id === roundId);
      if (!existing) throw httpError(404, "轮次不存在");
      if (existing.position !== input.position) {
        throw httpError(400, "请使用轮次排序操作", { path: "position" });
      }
      await client.query("DELETE FROM questions WHERE game_id=$1 AND round_id=$2",
        [gameId, roundId]);
      await client.query(`UPDATE rounds SET title=$3,duration_ms=$4
        WHERE game_id=$1 AND id=$2`,
      [gameId, roundId, input.title.trim(), input.durationMs]);
    } else {
      if (current.length >= 20) throw httpError(400, "最多 20 轮", { path: "position" });
      if (input.position !== current.length + 1) {
        throw httpError(400, "轮次序号须连续", { path: "position" });
      }
      roundId = randomUUID();
      await client.query(`INSERT INTO rounds
        (game_id,id,position,title,duration_ms,config_version)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [gameId, roundId, input.position, input.title.trim(), input.durationMs,
        input.expectedVersion]);
    }
    await insertQuestions(client, gameId, roundId, questions);
    const version = await bumpDraftVersion(client, gameId, input.expectedVersion,
      organizerId, "round_saved", roundId, Date.now());
    return { id: roundId, version };
  });
}

export async function deleteRound(pool, gameId, roundId, organizerId, expectedVersion) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  return withTransaction(pool, async (client) => {
    await lockDraft(client, gameId, expectedVersion);
    const rounds = (await client.query(`SELECT id,position FROM rounds
      WHERE game_id=$1 ORDER BY position`, [gameId])).rows;
    if (!rounds.some((round) => round.id === roundId)) throw httpError(404, "轮次不存在");
    await client.query("DELETE FROM questions WHERE game_id=$1 AND round_id=$2",
      [gameId, roundId]);
    await client.query("DELETE FROM rounds WHERE game_id=$1 AND id=$2", [gameId, roundId]);
    const remaining = rounds.filter((round) => round.id !== roundId);
    await resequence(client, gameId, remaining.map((round) => round.id));
    const version = await bumpDraftVersion(client, gameId, expectedVersion,
      organizerId, "round_deleted", roundId, Date.now());
    return { version };
  });
}

async function resequence(client, gameId, roundIds) {
  await client.query("UPDATE rounds SET position=position+1000 WHERE game_id=$1", [gameId]);
  for (const [index, roundId] of roundIds.entries()) {
    await client.query("UPDATE rounds SET position=$3 WHERE game_id=$1 AND id=$2",
      [gameId, roundId, index + 1]);
  }
}

export async function reorderRounds(pool, gameId, organizerId, { expectedVersion, roundIds } = {}) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  return withTransaction(pool, async (client) => {
    await lockDraft(client, gameId, expectedVersion);
    const existing = (await client.query("SELECT id FROM rounds WHERE game_id=$1", [gameId]))
      .rows.map((row) => row.id);
    if (!Array.isArray(roundIds) || roundIds.length !== existing.length
      || new Set(roundIds).size !== roundIds.length
      || roundIds.some((id) => !existing.includes(id))) {
      throw httpError(400, "轮次排序不完整", { path: "roundIds" });
    }
    await resequence(client, gameId, roundIds);
    const version = await bumpDraftVersion(client, gameId, expectedVersion,
      organizerId, "rounds_reordered", gameId, Date.now());
    return { version };
  });
}

export async function publishFrozen(pool, gameId, organizerId) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  return withTransaction(pool, async (client) => {
    const game = (await client.query(`SELECT slug,status,current_version,published_version
      FROM games WHERE id=$1 FOR UPDATE`, [gameId])).rows[0];
    if (!game) throw httpError(404, "游戏不存在");
    if (game.status === "published") {
      return {
        gameId, slug: game.slug, version: game.published_version ?? game.current_version,
        status: "published"
      };
    }
    if (game.status !== "draft") throw httpError(409, "游戏不能发布");
    const rounds = (await client.query(`SELECT id,position FROM rounds
      WHERE game_id=$1 ORDER BY position`, [gameId])).rows;
    if (!rounds.length || rounds.length > 20
      || rounds.some((round, index) => round.position !== index + 1)) {
      throw httpError(409, "请准备至少一轮完整题目", { path: "rounds" });
    }
    for (const round of rounds) {
      const rows = (await client.query(`SELECT position,kind,prompt,options_json,
        correct_option,answer_rule_json,points FROM questions
        WHERE game_id=$1 AND round_id=$2 ORDER BY position`,
      [gameId, round.id])).rows;
      if (!rows.length || rows.length > 100) {
        throw httpError(400, "每轮必须有 1–100 题", { path: "round.questions" });
      }
      const questions = rows.map((row, index) => {
        if (row.position !== index + 1) {
          throw httpError(400, "题号须连续", { path: `questions[${index}].position` });
        }
        return validateQuestion({
          position: row.position, kind: row.kind, prompt: row.prompt, points: row.points,
          ...(row.options_json ? { options: row.options_json } : {}),
          answerRule: row.answer_rule_json
        });
      });
      maxAnswerBytes(questions);
    }
    await client.query("UPDATE rounds SET config_version=$2 WHERE game_id=$1",
      [gameId, game.current_version]);
    await writeVersionSnapshot(client, gameId, game.current_version, Date.now());
    await client.query(`UPDATE games SET status='published',published_version=current_version
      WHERE id=$1`, [gameId]);
    await client.query(`INSERT INTO audit_events(game_id,actor_id,kind,target_id,
      details_json,occurred_at) VALUES($1,$2,'game_published',$3,$4::jsonb,$5)`,
    [gameId, organizerId, gameId, JSON.stringify({ version: game.current_version }), Date.now()]);
    return {
      gameId, slug: game.slug, version: game.current_version, status: "published"
    };
  });
}
