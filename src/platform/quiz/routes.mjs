import { requireOrganizer } from "../auth/sessions.mjs";
import { publishedGame } from "../players/repository.mjs";
import { createRound, getPublicRound, publishGame, startRound } from "./repository.mjs";

const uuid = "([0-9a-fA-F-]{36})";
const slug = "([a-z0-9-]{3,48})";

export function registerQuizRoutes(app) {
  app.route("POST", new RegExp(`^/v2/games/${uuid}/rounds$`),
    async ({ req, params, body, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { status: 201, body: await createRound(pool, params[0], actor.id, body) };
    });
  app.route("POST", new RegExp(`^/v2/games/${uuid}/publish$`),
    async ({ req, params, pool }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await publishGame(pool, params[0], actor.id) };
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
}
