import { requireAdmin } from "../auth.mjs";
import {
  importQuestionBank, startRound, getRoundState, settleDueRounds, publicQuestions, voidRound
} from "../rounds.mjs";

export function registerRoundRoutes(app, scorer = () => {}, onCriticalChange) {
  const settle = ({ db, clock }) => {
    const ids = settleDueRounds(db, clock(), scorer);
    if (ids.length) void Promise.resolve(onCriticalChange?.()).catch((error) => console.error("Backup failed:", error));
    return ids;
  };
  app.tick(settle);
  app.route("GET", /^\/api\/state$/, (ctx) => {
    settle(ctx);
    const submissionCounts = Object.fromEntries(ctx.db.prepare(`SELECT round_id,COUNT(DISTINCT player_id) AS count
      FROM submissions GROUP BY round_id`).all().map((row) => [row.round_id, row.count]));
    return { body: {
      serverTime: ctx.clock(),
      rounds: [1, 2, 3, 4].map((id) => getRoundState(ctx.db, id)),
      registeredCount: ctx.db.prepare("SELECT COUNT(*) AS count FROM players").get().count,
      submissionCounts: Object.fromEntries([1, 2, 3, 4].map((id) => [id, submissionCounts[id] ?? 0]))
    } };
  });
  app.route("GET", /^\/api\/rounds\/([1-4])$/, (ctx) => {
    settle(ctx);
    const id = Number(ctx.match[1]);
    return { body: { round: getRoundState(ctx.db, id), questions: publicQuestions(ctx.db, id) } };
  });
  app.route("POST", /^\/api\/admin\/questions\/import$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: importQuestionBank(ctx.db, ctx.body.questions, adminId, ctx.clock()) };
  });
  app.route("POST", /^\/api\/admin\/rounds\/([1-4])\/start$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    settle(ctx);
    return { body: startRound(ctx.db, Number(ctx.match[1]), adminId, ctx.clock()) };
  });
  app.route("POST", /^\/api\/admin\/rounds\/([1-4])\/void$/, (ctx) => {
    const adminId = requireAdmin(ctx);
    return { body: voidRound(ctx.db, Number(ctx.match[1]), ctx.body.reason, adminId, ctx.clock()) };
  });
  app.route("GET", /^\/api\/admin\/questions$/, (ctx) => {
    requireAdmin(ctx);
    const rows = ctx.db.prepare(`SELECT id,round_id,position,kind,prompt,options_json,
      correct_option,explanation,source FROM questions ORDER BY round_id,position`).all();
    return { body: { questions: rows.map((q) => ({
      id: q.id, roundId: q.round_id, position: q.position, kind: q.kind, prompt: q.prompt,
      ...(q.kind === "choice" ? { options: JSON.parse(q.options_json), correctOption: q.correct_option } : {}),
      explanation: q.explanation, source: q.source
    })) } };
  });
}
