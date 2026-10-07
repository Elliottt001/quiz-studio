import { requirePlayer } from "../auth.mjs";
import { saveDraft, submitAnswers } from "../answers.mjs";
import { settleDueRounds, getRoundState } from "../rounds.mjs";

export function registerAnswerRoutes(app, scorer) {
  app.route("PUT", /^\/api\/rounds\/([1-4])\/draft$/, (ctx) => {
    const playerId = requirePlayer(ctx);
    const id = Number(ctx.match[1]);
    settleDueRounds(ctx.db, ctx.clock(), scorer);
    return { body: saveDraft(ctx.db, playerId, id, ctx.body.answers, ctx.clock()) };
  });
  app.route("POST", /^\/api\/rounds\/([1-4])\/submit$/, (ctx) => {
    const playerId = requirePlayer(ctx);
    const id = Number(ctx.match[1]);
    // The idempotency lookup must run before settlement so an accepted retry
    // can return its original receipt after the deadline.
    const receipt = submitAnswers(ctx.db, playerId, id, ctx.body.answers, ctx.body.requestKey, ctx.clock());
    return { status: 201, body: receipt };
  });
  app.route("GET", /^\/api\/rounds\/([1-4])\/my$/, (ctx) => {
    const playerId = requirePlayer(ctx);
    const id = Number(ctx.match[1]);
    settleDueRounds(ctx.db, ctx.clock(), scorer);
    const draft = ctx.db.prepare("SELECT answers_json,saved_at FROM drafts WHERE player_id=? AND round_id=?")
      .get(playerId, id);
    const submission = ctx.db.prepare(`SELECT id,revision,submitted_at,answers_json FROM submissions
      WHERE player_id=? AND round_id=? ORDER BY revision DESC LIMIT 1`).get(playerId, id);
    const score = ctx.db.prepare("SELECT points,answers_json FROM round_scores WHERE player_id=? AND round_id=?")
      .get(playerId, id);
    const published = getRoundState(ctx.db, id).status === "published";
    return { body: {
      draft: draft ? { answers: JSON.parse(draft.answers_json), savedAt: draft.saved_at } : null,
      submission: submission ? {
        id: submission.id, revision: submission.revision,
        submittedAt: submission.submitted_at,
        answers: JSON.parse(submission.answers_json)
      } : null,
      score: published && score ? { points: score.points, detail: JSON.parse(score.answers_json) } : null
    } };
  });
}
