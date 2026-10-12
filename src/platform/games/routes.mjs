import { requireOrganizer } from "../auth/sessions.mjs";
import { createGame, getGameForMember, listGamesForMember } from "./repository.mjs";
import { getEditor, saveDetails } from "./editor.mjs";
import { inviteOperator, removeOperator } from "./members.mjs";

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
  app.route("POST", /^\/v2\/games\/([0-9a-fA-F-]{36})\/members$/,
    async ({ req, params, body, pool, clock }) => {
      const actor = await requireOrganizer(pool, req);
      return { body: await inviteOperator(pool, params[0], actor.id, body?.login, clock()) };
    });
  app.route("DELETE", /^\/v2\/games\/([0-9a-fA-F-]{36})\/members\/([0-9a-fA-F-]{36})$/,
    async ({ req, params, pool, clock }) => {
      const actor = await requireOrganizer(pool, req);
      await removeOperator(pool, params[0], actor.id, params[1], clock());
      return { body: { ok: true } };
    });
}
