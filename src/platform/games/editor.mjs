import { withTransaction } from "../db/pool.mjs";
import { requireGameRole } from "./repository.mjs";
import { httpError } from "../http/errors.mjs";

const length = (value) => Array.from(value).length;

function invalid(path, message) {
  throw httpError(400, message, { path });
}

export function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length > 12) {
    invalid("fields", "报名字段不能超过 12 项");
  }
  const keys = new Set();
  return fields.map((field, index) => {
    const prefix = `fields[${index}]`;
    if (!field || typeof field.key !== "string"
      || !/^[a-z][a-z0-9_]{0,31}$/.test(field.key) || keys.has(field.key)) {
      invalid(`${prefix}.key`, "字段标识无效或重复");
    }
    keys.add(field.key);
    if (typeof field.label !== "string" || !field.label.trim()
      || length(field.label.trim()) > 40) invalid(`${prefix}.label`, "字段名称无效");
    if (typeof field.required !== "boolean") {
      invalid(`${prefix}.required`, "必填设置无效");
    }
    const help = field.help ?? "";
    if (typeof help !== "string" || length(help) > 120) {
      invalid(`${prefix}.help`, "帮助文字过长");
    }
    const common = {
      key: field.key, label: field.label.trim(), required: field.required,
      help: help.trim()
    };
    if (field.type === "text") {
      const minLength = field.minLength ?? 0;
      const maxLength = field.maxLength ?? 120;
      if (!Number.isInteger(minLength) || !Number.isInteger(maxLength)
        || minLength < 0 || maxLength < 1 || maxLength > 120 || minLength > maxLength) {
        invalid(`${prefix}.maxLength`, "文本长度必须介于 1–120 字");
      }
      return { ...common, type: "text", minLength, maxLength };
    }
    if (field.type === "select") {
      if (!Array.isArray(field.options) || field.options.length < 2
        || field.options.length > 20
        || field.options.some((option) => typeof option !== "string"
          || !option.trim() || length(option.trim()) > 80)) {
        invalid(`${prefix}.options`, "选项须为 2–20 个有效文本");
      }
      const options = field.options.map((option) => option.trim());
      if (new Set(options).size !== options.length) {
        invalid(`${prefix}.options`, "选项不能重复");
      }
      return { ...common, type: "select", options };
    }
    invalid(`${prefix}.type`, "字段类型不受支持");
  });
}

function mapQuestion(row) {
  return {
    id: row.id, position: row.position, kind: row.kind, prompt: row.prompt,
    points: row.points,
    ...(row.options_json ? { options: row.options_json } : {}),
    answerRule: row.answer_rule_json
  };
}

export async function writeVersionSnapshot(client, gameId, nextVersion, now, detailsOverride) {
  const game = (await client.query("SELECT title FROM games WHERE id=$1", [gameId])).rows[0];
  if (!game) throw httpError(404, "游戏不存在");
  const previous = (await client.query(`SELECT config_json FROM game_versions
    WHERE game_id=$1 AND version<$2 ORDER BY version DESC LIMIT 1`,
  [gameId, nextVersion])).rows[0]?.config_json ?? {};
  const details = {
    title: game.title,
    description: detailsOverride?.description ?? previous.description ?? "",
    fields: detailsOverride?.fields ?? previous.fields ?? [],
    leaderboard: detailsOverride?.leaderboard ?? previous.leaderboard ?? true
  };
  const rounds = (await client.query(`SELECT id,position,title,duration_ms
    FROM rounds WHERE game_id=$1 ORDER BY position`, [gameId])).rows;
  const allQuestions = (await client.query(`SELECT id,round_id,position,kind,prompt,
    options_json,answer_rule_json,points FROM questions WHERE game_id=$1
    ORDER BY round_id,position`, [gameId])).rows;
  const config = {
    ...details,
    rounds: rounds.map((round) => ({
      id: round.id, position: round.position, title: round.title,
      durationMs: round.duration_ms,
      questions: allQuestions.filter((question) => question.round_id === round.id)
        .map(mapQuestion)
    }))
  };
  await client.query(`INSERT INTO game_versions(game_id,version,config_json,created_at)
    VALUES($1,$2,$3::jsonb,$4)
    ON CONFLICT(game_id,version) DO UPDATE
    SET config_json=excluded.config_json,created_at=excluded.created_at`,
  [gameId, nextVersion, JSON.stringify(config), now]);
}

export async function getEditor(pool, gameId, organizerId) {
  await requireGameRole(pool, gameId, organizerId, ["owner", "operator"]);
  return withTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const row = (await client.query(`SELECT g.id,g.slug,g.title,g.status,g.owner_id,
      g.current_version,m.role FROM games g JOIN game_members m ON m.game_id=g.id
      WHERE g.id=$1 AND m.organizer_id=$2`, [gameId, organizerId])).rows[0];
    if (!row) throw httpError(404, "游戏不存在");
    const config = (await client.query(`SELECT config_json FROM game_versions
      WHERE game_id=$1 AND version=$2`,
    [gameId, row.current_version])).rows[0]?.config_json ?? {};
    const rounds = (await client.query(`SELECT id,position,title,duration_ms,status
      FROM rounds WHERE game_id=$1 ORDER BY position`, [gameId])).rows;
    const questions = (await client.query(`SELECT id,round_id,position,kind,prompt,options_json,
      answer_rule_json,points FROM questions WHERE game_id=$1 ORDER BY round_id,position`,
    [gameId])).rows;
    return {
      game: {
        id: row.id, slug: row.slug, title: row.title,
        status: row.status, ownerId: row.owner_id
      },
      version: row.current_version,
      role: row.role,
      description: config.description ?? "",
      fields: config.fields ?? [],
      leaderboard: config.leaderboard ?? true,
      rounds: rounds.map((round) => ({
        id: round.id, position: round.position, title: round.title,
        durationMs: round.duration_ms, status: round.status,
        questions: questions.filter((question) => question.round_id === round.id)
          .map(mapQuestion)
      }))
    };
  });
}

export async function saveDetails(pool, gameId, organizerId, input) {
  await requireGameRole(pool, gameId, organizerId, ["owner"]);
  if (!input || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    invalid("expectedVersion", "草稿版本无效");
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || length(title) > 120) invalid("title", "游戏名称无效");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (length(description) > 2_000) invalid("description", "游戏介绍不得超过 2000 字");
  if (typeof input.leaderboard !== "boolean") invalid("leaderboard", "榜单设置无效");
  const fields = validateFields(input.fields);
  return withTransaction(pool, async (client) => {
    const game = (await client.query(`SELECT status,current_version FROM games
      WHERE id=$1 FOR UPDATE`, [gameId])).rows[0];
    if (game?.status !== "draft") throw httpError(409, "游戏已发布");
    if (game.current_version !== input.expectedVersion) {
      throw httpError(409, "草稿版本冲突", { currentVersion: game.current_version });
    }
    const version = game.current_version + 1;
    await client.query("UPDATE games SET title=$2,current_version=$3 WHERE id=$1",
      [gameId, title, version]);
    await writeVersionSnapshot(client, gameId, version, Date.now(), {
      description, fields, leaderboard: input.leaderboard
    });
    await client.query(`INSERT INTO audit_events
      (game_id,actor_id,kind,target_id,details_json,occurred_at)
      VALUES($1,$2,'details_saved',$3,$4::jsonb,$5)`,
    [gameId, organizerId, gameId,
      JSON.stringify({ previousVersion: game.current_version, version }), Date.now()]);
    return { version };
  });
}
