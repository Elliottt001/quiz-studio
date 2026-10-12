import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withTransaction } from "../../src/platform/db/pool.mjs";
import { migrate } from "../../src/platform/db/migrate.mjs";
import { newPlatformFixture } from "./helpers.mjs";

test("fresh migrations are empty, repeatable, and transactions release after rollback", async () => {
  const { pool, close } = await newPlatformFixture({ migrateSchema: false });
  try {
    await migrate(pool);
    await migrate(pool);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM games")).rows[0].n, 0);
    await assert.rejects(withTransaction(pool, async (client) => {
      await client.query("INSERT INTO organizers(id,login,password_hash) VALUES($1,$2,$3)",
        [randomUUID(), "rollback-test", "hash"]);
      throw new Error("abort");
    }), /abort/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organizers")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
  } finally {
    await close();
  }
});

test("a question cannot reference a round from another game", async () => {
  const { pool, close } = await newPlatformFixture();
  try {
    const owner = randomUUID();
    const gameA = randomUUID();
    const gameB = randomUUID();
    const roundA = randomUUID();
    await pool.query("INSERT INTO organizers(id,login,password_hash) VALUES($1,'owner','hash')", [owner]);
    await pool.query(`INSERT INTO games(id,slug,title,owner_id) VALUES
      ($1,'first','First',$3),($2,'second','Second',$3)`, [gameA, gameB, owner]);
    await pool.query(`INSERT INTO game_versions(game_id,version) VALUES($1,1),($2,1)`,
      [gameA, gameB]);
    await pool.query(`INSERT INTO rounds(game_id,id,position,title,duration_ms,config_version)
      VALUES($1,$2,1,'Round',90000,1)`, [gameA, roundA]);
    await assert.rejects(pool.query(`INSERT INTO questions
      (game_id,id,round_id,position,kind,prompt,options_json,correct_option,points)
      VALUES($1,$2,$3,1,'choice','Q','["A","B"]',0,7)`,
    [gameB, randomUUID(), roundA]), (error) => error.code === "23503");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM questions")).rows[0].n, 0);
  } finally {
    await close();
  }
});

test("a rollback failure releases a broken pool client exactly once", async () => {
  let releases = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql === "ROLLBACK") throw new Error("connection lost");
        },
        release() {
          releases++;
          if (releases > 1) throw new Error("released twice");
        }
      };
    }
  };
  await assert.rejects(withTransaction(pool, async () => {
    throw new Error("original failure");
  }), /original failure/);
  assert.equal(releases, 1);
});
