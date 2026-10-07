import { requireAdmin } from "../auth.mjs";
import {
  importQuestionBank, startRound, getRoundState, settleDueRounds, publicQuestions
} from "../rounds.mjs";

export function registerRoundRoutes(app, scorer = () => {}) {
  const settle = ({ db, clock }) => settleDueRounds(db, clock(), scorer);
  app.tick(settle);
  app.route("GET", /^\/api\/state$/, (ctx) => {
    settle(ctx);
    return { body: { serverTime: ctx.clock(), rounds: [1, 2, 3, 4].map((id) => getRoundState(ctx.db, id)) } };
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
}
