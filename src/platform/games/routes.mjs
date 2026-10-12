import { requireOrganizer } from "../auth/sessions.mjs";
import { createGame, getGameForMember, listGamesForMember } from "./repository.mjs";
import { getEditor, saveDetails } from "./editor.mjs";

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
  app.route("GET", /^\/v2\/games\/([^/]+)\/editor$/, async ({ req, params, pool }) => {
    const actor = await requireOrganizer(pool, req);
    return { body: await getEditor(pool, params[0], actor.id) };
  });
  app.route("PATCH", /^\/v2\/games\/([^/]+)\/details$/, async ({ req, params, body, pool }) => {
    const actor = await requireOrganizer(pool, req);
    return { body: await saveDetails(pool, params[0], actor.id, body) };
  });
}
