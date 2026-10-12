import { requireOrganizer } from "../auth/sessions.mjs";
import { publishedGame } from "../players/repository.mjs";
import { requirePlayerForGame } from "../players/repository.mjs";
import {
  createRound, getPublicRound, publishGame, startRound, submitAnswers
} from "./repository.mjs";
import {
  saveRound, deleteRound, reorderRounds, publishFrozen
} from "./editor.mjs";

const uuid = "([0-9a-fA-F-]{36})";
const slug = "([a-z0-9-]{3,48})";

export function registerQuizRoutes(app) {
  app.route("POST", new RegExp(`^/v2/games/${uuid}/rounds$`),
    async ({ req, params, body, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { status: 201, body: body?.expectedVersion === undefined
        ? await createRound(pool, params[0], actor.id, body)
        : await saveRound(pool, params[0], actor.id, body) };
    });
  app.route("PUT", new RegExp(`^/v2/games/${uuid}/rounds/${uuid}$`),
    async ({ req, params, body, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await saveRound(pool, params[0], actor.id,
        { ...body, roundId: params[1] }) };
    });
  app.route("DELETE", new RegExp(`^/v2/games/${uuid}/rounds/${uuid}$`),
    async ({ req, params, body, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await deleteRound(pool, params[0], params[1], actor.id,
        body.expectedVersion) };
    });
  app.route("PATCH", new RegExp(`^/v2/games/${uuid}/rounds/order$`),
    async ({ req, params, body, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await reorderRounds(pool, params[0], actor.id, body) };
    });
  app.route("POST", new RegExp(`^/v2/games/${uuid}/publish$`),
    async ({ req, params, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await publishFrozen(pool, params[0], actor.id) };
    });
  app.route("POST", new RegExp(`^/v2/games/${uuid}/rounds/${uuid}/start$`),
    async ({ req, params, pool, clock }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await startRound(pool, params[0], params[1], actor.id, clock()) };
    });
  app.route("GET", new RegExp(`^/v2/games/${slug}/rounds/${uuid}$`),
    async ({ params, pool }) => {
      const game = await publishedGame(pool, params[0]);
      return { body: await getPublicRound(pool, game.id, params[1]) };
    });
  app.route("POST", new RegExp(`^/v2/games/${slug}/rounds/${uuid}/submit$`),
    async ({ req, params, body, pool, receivedAt }) => {
      const game = await publishedGame(pool, params[0]);
      const playerId = await requirePlayerForGame(pool, req, game.id);
      const receipt = await submitAnswers(pool, {
        gameId: game.id, playerId, roundId: params[1],
        answers: body?.answers, requestKey: body?.requestKey, receivedAt
      });
      return { status: 201, body: receipt };
    });
  app.route("GET", new RegExp(`^/v2/games/${slug}/rounds/${uuid}/my$`),
    async ({ req, params, pool }) => {
      const game = await publishedGame(pool, params[0]);
      const playerId = await requirePlayerForGame(pool, req, game.id);
      const round = (await pool.query("SELECT status FROM rounds WHERE game_id=$1 AND id=$2",
        [game.id, params[1]])).rows[0];
      if (!round) return { status: 404, body: { error: "轮次不存在" } };
      const submitted = (await pool.query(`SELECT id,revision,submitted_at,answers_json FROM submissions
        WHERE game_id=$1 AND player_id=$2 AND round_id=$3 ORDER BY revision DESC LIMIT 1`,
      [game.id, playerId, params[1]])).rows[0];
      const score = round.status === "published"
        ? (await pool.query(`SELECT points FROM round_scores
          WHERE game_id=$1 AND player_id=$2 AND round_id=$3`,
        [game.id, playerId, params[1]])).rows[0]?.points ?? null
        : null;
      return { body: { submission: submitted ? {
        id: submitted.id, revision: submitted.revision,
        submittedAt: Number(submitted.submitted_at), answers: submitted.answers_json
      } : null, score } };
    });
  app.route("GET", new RegExp(`^/v2/games/${slug}/standings$`),
    async ({ params, pool }) => {
      const game = await publishedGame(pool, params[0]);
      const rows = (await pool.query(`SELECT p.id,p.display_name,COALESCE(SUM(s.points),0)::int AS score
        FROM players p LEFT JOIN round_scores s
          ON s.game_id=p.game_id AND s.player_id=p.id
        WHERE p.game_id=$1 GROUP BY p.game_id,p.id,p.display_name
        ORDER BY score DESC,p.id`, [game.id])).rows;
      let lastScore;
      let rank = 0;
      return { body: { players: rows.map((row, index) => {
        if (row.score !== lastScore) rank = index + 1;
        lastScore = row.score;
        return { id: row.id, displayName: row.display_name, score: row.score, rank };
      }) } };
    });
}
