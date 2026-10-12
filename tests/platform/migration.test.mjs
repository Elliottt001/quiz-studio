import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrate } from "../../src/platform/db/migrate.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("configuration migration preserves published choice answers and scores", async () => {
  const { pool, close } = await newPlatformFixture({ migrateSchema: false });
  try {
    await pool.query(`CREATE TABLE schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const version of [1, 2, 3]) {
      const filename = [
        "001_foundation.sql", "002_platform_audit.sql", "003_player_session_expiry.sql"
      ][version - 1];
      await pool.query(readFileSync(
        new URL(`../../src/platform/db/migrations/${filename}`, import.meta.url), "utf8"
      ));
      await pool.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    }
    const [ownerId, gameId, roundId, questionId, playerId, submissionId] =
      Array.from({ length: 6 }, () => randomUUID());
    await pool.query("INSERT INTO organizers(id,login,password_hash) VALUES($1,'owner','hash')",
      [ownerId]);
    await pool.query(`INSERT INTO games(id,slug,title,owner_id,status)
      VALUES($1,'legacy-choice','Old choice',$2,'published')`, [gameId, ownerId]);
    await pool.query("INSERT INTO game_versions(game_id,version) VALUES($1,1)", [gameId]);
    await pool.query(`INSERT INTO rounds(game_id,id,position,title,duration_ms,status,config_version)
      VALUES($1,$2,1,'One',30000,'published',1)`, [gameId, roundId]);
    await pool.query(`INSERT INTO questions
      (game_id,id,round_id,position,kind,prompt,options_json,correct_option,points)
      VALUES($1,$2,$3,1,'choice','Which?','["A","B"]',1,7)`,
    [gameId, questionId, roundId]);
    await pool.query(`INSERT INTO players
      (game_id,id,display_name,login_code,password_hash,created_at)
      VALUES($1,$2,'Player','AAAA1111AAAA1111','hash',100)`, [gameId, playerId]);
    await pool.query(`INSERT INTO submissions
      (game_id,id,player_id,round_id,request_key,answers_json,revision,submitted_at)
      VALUES($1,$2,$3,$4,'first',$5::jsonb,1,200)`,
    [gameId, submissionId, playerId, roundId, JSON.stringify({ [questionId]: 1 })]);
    await pool.query(`INSERT INTO round_scores
      (game_id,player_id,round_id,points,detail_json)
      VALUES($1,$2,$3,7,$4::jsonb)`, [gameId, playerId, roundId,
      JSON.stringify({ [questionId]: 7 })]);

    await migrate(pool);
    await migrate(pool);
    const question = (await pool.query(
      "SELECT kind,answer_rule_json FROM questions WHERE game_id=$1 AND id=$2",
      [gameId, questionId]
    )).rows[0];
    assert.equal(question.kind, "choice");
    assert.deepEqual(question.answer_rule_json, { correctOption: 1 });
    assert.equal((await pool.query("SELECT published_version FROM games WHERE id=$1",
      [gameId])).rows[0].published_version, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE id=$1",
      [submissionId])).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT points FROM round_scores
      WHERE game_id=$1 AND player_id=$2`, [gameId, playerId])).rows[0].points, 7);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 4);
  } finally {
    await close();
  }
});
