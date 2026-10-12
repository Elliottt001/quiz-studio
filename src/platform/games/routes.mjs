import { requireOrganizer } from "../auth/sessions.mjs";
import { createGame, getGameForMember, listGamesForMember } from "./repository.mjs";

export function registerGameRoutes(app) {
  app.route("POST", /^\/v2\/games$/, async ({ req, body, pool }) => {
    const actor = await requireOrganizer(pool, req);
    return { status: 201, body: await createGame(pool, actor.id, body) };
  });
  app.route("GET", /^\/v2\/games$/, async ({ req, pool }) => {
    const actor = await requireOrganizer(pool, req);
    return { body: { games: await listGamesForMember(pool, actor.id) } };
  });
  app.route("GET", /^\/v2\/games\/([^/]+)$/, async ({ req, params, pool }) => {
    const actor = await requireOrganizer(pool, req);
    return { body: await getGameForMember(pool, params[0], actor.id) };
  });
}
