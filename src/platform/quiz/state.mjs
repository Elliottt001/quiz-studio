import { publishedGame } from "../players/repository.mjs";

export async function publicState(pool, slug, now) {
  const game = await publishedGame(pool, slug);
  const detail = (await pool.query(`SELECT g.title,v.config_json FROM games g
    JOIN game_versions v ON v.game_id=g.id
      AND v.version=COALESCE(g.published_version,1)
    WHERE g.id=$1`, [game.id])).rows[0];
  const rows = (await pool.query(`SELECT r.id,r.position,r.title,r.status,r.duration_ms,
    r.started_at,r.deadline_at,r.published_at,
    (SELECT count(*)::int FROM questions q
      WHERE q.game_id=r.game_id AND q.round_id=r.id) AS question_count,
    (SELECT count(DISTINCT s.player_id)::int FROM submissions s
      WHERE s.game_id=r.game_id AND s.round_id=r.id) AS submission_count
    FROM rounds r WHERE r.game_id=$1 ORDER BY r.position`, [game.id])).rows;
  return {
    serverTime: now,
    game: {
      slug: game.slug, title: detail.title,
      description: detail.config_json.description ?? ""
    },
    rounds: rows.map((row) => ({
      id: row.id, position: row.position, title: row.title,
      status: row.status, durationMs: row.duration_ms,
      startedAt: row.started_at === null ? null : Number(row.started_at),
      deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
      publishedAt: row.published_at === null ? null : Number(row.published_at),
      questionCount: row.question_count, submissionCount: row.submission_count
    }))
  };
}
