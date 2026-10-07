import { api, remainingLabel, teamNames } from "./api.mjs";
import { runAdminAction } from "./admin-actions.mjs";

const $ = (id) => document.getElementById(id);
const byId = (id) => document.querySelector(`[data-round="${id}"]`);
const labels = { prepared: "待开启", open: "作答中", settling: "结算中", published: "已公布", voided: "已作废" };
const tierNames = { third: "三等奖", second: "二等奖", grand: "大奖" };
let snapshot = null;
let offset = 0;
let players = [];
let pendingDrawKeys = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(text, error = false) {
  $("admin-notice").textContent = text;
  $("admin-notice").hidden = !text;
  $("admin-notice").style.color = error ? "#ffe4ba" : "#b9f7f4";
}

async function action(operation, successMessage) {
  return runAdminAction(operation, successMessage, message, refresh);
}

function renderRounds(state, questions, frozen) {
  for (const round of state.rounds) {
    const row = byId(round.id);
    row.querySelector(".status-label").textContent = labels[round.status] ?? round.status;
    const count = questions.filter((q) => q.roundId === round.id).length;
    row.querySelector("[data-start]").disabled = frozen || round.status !== "prepared"
      || count !== [6, 10, 9, 5][round.id - 1];
    row.querySelector("[data-void]").disabled = frozen || !["open", "published"].includes(round.status);
  }
  const open = state.rounds.find((round) => round.status === "open");
  $("current-status").textContent = open ? remainingLabel(open.deadlineAt - (Date.now() + offset))
    : state.rounds.some((round) => round.status === "settling") ? "结算中" : "待命";
  $("submitted-count").textContent = open ? state.submissionCounts[open.id] : "—";
}

function playerRow(profile, frozen) {
  const row = el("article", "player-row");
  const top = el("div", "player-row-top");
  top.append(el("strong", "", profile.nickname), el("small", "", profile.realName));
  top.append(el("em", "", `${profile.score} 分`));
  const meta = el("p", "player-row-meta",
    `${profile.grade} 级 · ${teamNames[profile.team]} · ${profile.id.slice(0, 8)} · ${
      profile.excluded ? "已排除" : profile.qualified ? "待领奖核验" : "未提交正式答卷"
    }${profile.suspectedDuplicate ? " · 疑似重复，请人工核对" : ""}`);
  const buttons = el("div", "player-row-actions");
  const select = el("button", "action ghost", "选为加分对象");
  select.type = "button";
  select.addEventListener("click", () => {
    $("bonus-player").value = profile.id;
    $("bonus-player").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  buttons.append(select);
  const recovery = el("button", "action secondary", "生成恢复码");
  recovery.type = "button";
  recovery.addEventListener("click", () => void action(async () => {
    const { code } = await api(`/api/admin/players/${profile.id}/recover`, { method: "POST", body: {} });
    return `${profile.realName} 的一次性恢复码：${code}（10 分钟有效，交给本人在新设备输入）`;
  }, ""));
  buttons.append(recovery);
  const override = el("button", "action ghost", "工作资格");
  override.type = "button";
  override.disabled = frozen || profile.workOverride;
  override.addEventListener("click", () => {
    const reason = prompt(`确认 ${profile.realName} 因现场工作无法答题？填写任务依据：`);
    if (reason) void action(() => api(`/api/admin/players/${profile.id}/work-override`, {
      method: "POST", body: { reason }
    }), "工作资格已登记");
  });
  buttons.append(override);
  const exclude = el("button", "action ghost", "排除奖池");
  exclude.type = "button";
  exclude.disabled = frozen || profile.excluded;
  exclude.addEventListener("click", () => {
    const reason = prompt(`排除 ${profile.realName} 的抽奖资格？请填写可追溯原因：`);
    if (reason) void action(() => api(`/api/admin/players/${profile.id}/exclude`, {
      method: "POST", body: { reason }
    }), "资格已更新");
  });
  buttons.append(exclude);
  row.append(top, meta, buttons);
  return row;
}

function renderPlayers(frozen) {
  const query = $("player-search").value.trim().toLowerCase();
  const list = $("players-list");
  list.replaceChildren();
  const visible = players.filter((profile) =>
    `${profile.realName} ${profile.nickname} ${profile.id}`.toLowerCase().includes(query));
  for (const profile of visible) list.append(playerRow(profile, frozen));
  if (!visible.length) list.append(el("p", "help", "没有匹配的玩家"));
}

function renderBonuses(bonuses, frozen) {
  const list = $("bonus-list");
  list.replaceChildren();
  const active = bonuses.filter((bonus) => bonus.voided_at === null);
  for (const bonus of active.slice(0, 24)) {
    const row = el("div", "bonus-item");
    const player = players.find((person) => person.id === bonus.player_id);
    row.append(el("span", "", `${player?.nickname ?? bonus.player_id.slice(0, 8)} · +${bonus.points} · ${bonus.reason}`));
    const button = el("button", "action ghost", "撤销");
    button.disabled = frozen;
    button.addEventListener("click", () => {
      const reason = prompt(`确认撤销 ${player?.realName ?? "该玩家"} 的这条加分？填写依据：`);
      if (reason) void action(() => api(`/api/admin/bonuses/${bonus.id}/void`, {
        method: "POST", body: { reason }
      }), "误录加分已撤销，原记录及原因保留");
    });
    row.append(button);
    list.append(row);
  }
  if (!active.length) list.append(el("p", "help", "暂无加分记录"));
}

function renderPrizes(prizes, draws, pool) {
  const list = $("prize-actions");
  list.replaceChildren();
  for (const prize of prizes) {
    const row = el("div", "prize-row");
    const latest = draws.filter((draw) => draw.prizeId === prize.id).at(-1);
    const active = latest && latest.status !== "refused" ? latest : null;
    const person = players.find((entry) => entry.id === active?.playerId);
    row.append(el("strong", "", `${tierNames[prize.tier]} · ${prize.title}`));
    if (active) {
      row.append(el("small", "", `${person?.nickname ?? active.playerId.slice(0, 8)} · 球号 ${active.selectedBallId.split(":").at(-1)}`));
      if (active.status === "pending") {
        const claim = el("button", "action secondary", "标记已领取");
        claim.addEventListener("click", () => void action(() => api(`/api/admin/draws/${active.id}/confirm`, {
          method: "POST", body: {}
        }), "领奖已登记"));
        const refuse = el("button", "action ghost", "放弃并补抽");
        refuse.addEventListener("click", () => {
          const reason = prompt("请填写本人放弃或资格异常的原因；原中奖者不会回到奖池：");
          if (reason) void action(() => api(`/api/admin/draws/${active.id}/refuse`, {
            method: "POST", body: { reason }
          }), "放弃记录已保存，请公开进行补抽");
        });
        row.append(claim, refuse);
      } else row.append(el("small", "", "已领取"));
    } else {
      const button = el("button", "action primary", latest ? "公开补抽" : "抽取这一奖");
      button.disabled = !pool;
      button.addEventListener("click", () => {
        if (!confirm(`投屏后公开抽取 ${prize.title}？中奖结果会立即保存，不能重抽。`)) return;
        const key = pendingDrawKeys.get(prize.id) ?? crypto.randomUUID();
        pendingDrawKeys.set(prize.id, key);
        void action(async () => {
          await api(`/api/admin/prizes/${prize.id}/draw`, { method: "POST", body: { requestKey: key } });
          pendingDrawKeys.delete(prize.id);
        }, "结果已保存，投屏页面将揭晓中奖小球");
      });
      row.append(button);
    }
    list.append(row);
  }
}

function renderAudit(events) {
  const list = $("audit-list");
  list.replaceChildren();
  const titles = {
    round_started: "管理员开启轮次", round_published: "系统自动收卷公布",
    answer_submitted: "玩家成功交卷", questions_imported: "正式题库导入",
    bonus_added: "额外积分审核", player_excluded: "排除抽奖资格",
    pool_frozen: "最终小球奖池冻结", prizes_configured: "奖品清单保存",
    prize_drawn: "抽出虚拟小球", prize_claimed: "领取奖品",
    prize_refused: "奖品放弃", round_voided: "轮次作废", question_voided: "题目作废",
    work_override: "工作参奖资格"
  };
  for (const event of events.slice(0, 18)) {
    const line = el("li");
    line.append(el("span", "", `${titles[event.kind] ?? event.kind} · ${event.targetId.slice(0, 10)}`));
    const time = el("time", "", new Date(event.occurredAt).toLocaleTimeString("zh-CN", { hour12: false }));
    line.append(time);
    list.append(line);
  }
}

function renderQuestionCorrection(questions, frozen) {
  const select = $("void-question-id");
  const selected = select.value;
  select.replaceChildren(new Option("请选择需要全员作废的题目", ""));
  for (const question of questions) {
    const label = `第 ${question.roundId} 轮 · ${String(question.position).padStart(2, "0")} · ${question.prompt}`;
    select.add(new Option(label, question.id));
  }
  if (questions.some((question) => question.id === selected)) select.value = selected;
  $("void-question-button").disabled = frozen || questions.length === 0;
}

async function refresh() {
  if ($("dashboard").hidden) return;
  try {
    const [state, accounts, questionBank, poolResponse, prizeResponse, drawn, audit, bonuses] = await Promise.all([
      api("/api/state"), api("/api/admin/players"), api("/api/admin/questions"),
      api("/api/pool"), api("/api/prizes"), api("/api/draws"), api("/api/admin/audit"),
      api("/api/admin/bonuses")
    ]);
    offset = state.serverTime - Date.now();
    players = accounts.players;
    snapshot = { state, pool: poolResponse.pool, prizes: prizeResponse.prizes, draws: drawn.draws };
    $("registered-count").textContent = state.registeredCount;
    $("question-count").textContent = `${questionBank.questions.length} / 30 题`;
    $("question-summary").textContent = questionBank.questions.length === 30
      ? "30 道题已导入。开题前请再次确认来源和答案。"
      : "尚未准备完成正式题卷，不允许开题。";
    $("balls-count").textContent = snapshot.pool
      ? snapshot.pool.entries.reduce((sum, entry) => sum + entry.balls, 0)
      : "未冻结";
    $("freeze-label").textContent = snapshot.pool
      ? `冻结版本 ${snapshot.pool.id.slice(0, 8)} · ${snapshot.pool.entries.length} 人`
      : "先完成四轮、名单核验和奖品配置";
    $("freeze-button").disabled = !!snapshot.pool;
    $("prize-form").querySelector("button").disabled = !!snapshot.pool;
    $("import-button").disabled = state.rounds.some((round) => round.status !== "prepared");
    renderQuestionCorrection(questionBank.questions, !!snapshot.pool);
    renderRounds(state, questionBank.questions, !!snapshot.pool);
    renderPlayers(!!snapshot.pool);
    renderBonuses(bonuses.bonuses, !!snapshot.pool);
    renderPrizes(snapshot.prizes, snapshot.draws, snapshot.pool);
    renderAudit(audit.events);
  } catch (error) {
    message(`控制台暂时无法同步：${error.message}`, true);
    if (error.status === 401) {
      $("dashboard").hidden = true;
      $("login-view").hidden = false;
    }
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/login", {
      method: "POST", body: { password: $("admin-password").value }
    });
    $("admin-password").value = "";
    $("login-view").hidden = true;
    $("dashboard").hidden = false;
    $("admin-logout").hidden = false;
    message("");
    await refresh();
  } catch (error) { message(error.message, true); }
});
$("admin-logout").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST", body: {} });
    $("dashboard").hidden = true;
    $("login-view").hidden = false;
    $("admin-logout").hidden = true;
    message("管理员已退出，公用电脑可由下一位玩家登录。");
  } catch (error) { message(error.message, true); }
});

document.querySelectorAll("[data-start]").forEach((button) => button.addEventListener("click", () => {
  const id = Number(button.dataset.start);
  if (!confirm(`确定现在开启第 ${id} 轮？这将是唯一开题触发，服务器马上计时五分钟。`)) return;
  button.disabled = true;
  void action(() => api(`/api/admin/rounds/${id}/start`, { method: "POST", body: {} }), `第 ${id} 轮已手动开启`);
}));
document.querySelectorAll("[data-void]").forEach((button) => button.addEventListener("click", () => {
  const reason = prompt(`确认作废第 ${button.dataset.void} 轮？将对所有玩家统一撤销该轮分数。填写原因：`);
  if (reason) void action(() => api(`/api/admin/rounds/${button.dataset.void}/void`, {
    method: "POST", body: { reason }
  }), "本轮已作废，全员分数已统一调整");
}));
$("question-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) $("question-json").value = await file.text();
});
$("import-button").addEventListener("click", () => void action(async () => {
  const input = JSON.parse($("question-json").value);
  await api("/api/admin/questions/import", {
    method: "POST", body: { questions: Array.isArray(input) ? input : input.questions }
  });
}, "题库已导入，请检查30道题和答案依据"));
$("void-question-button").addEventListener("click", () => {
  const id = $("void-question-id").value;
  if (!id) return message("请先选择要作废的题目", true);
  const reason = prompt(`确定全员作废题目 ${id} 并重算？填写可公示的依据：`);
  if (!reason) return;
  void action(() => api(`/api/admin/questions/${encodeURIComponent(id)}/void`, {
    method: "POST", body: { reason }
  }), "题目已作废，该题对全体记 0 分并重算");
});
$("player-search").addEventListener("input", () => renderPlayers(!!snapshot?.pool));
$("bonus-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  void action(() => api("/api/admin/bonus", {
    method: "POST", body: { ...input, points: 10 }
  }), "额外积分已审核记账");
});
$("prize-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const prizes = [];
  for (const tier of ["third", "second", "grand"]) {
    const title = data[`${tier}Title`];
    const count = Number(data[`${tier}Count`]);
    for (let n = 1; n <= count; n++) prizes.push({
      id: `${tier}-${n}`, tier, title, position: n
    });
  }
  if (!prizes.length) return message("至少配置一份真实奖品", true);
  void action(() => api("/api/admin/prizes", {
    method: "POST", body: { prizes }
  }), "奖品配置已保存；请按真实数量联排领奖动线");
});
$("freeze-button").addEventListener("click", () => {
  if (!confirm("已经核对全部成绩、重复账号与奖品数量？冻结后不能再修改积分和资格。")) return;
  void action(() => api("/api/admin/pool/freeze", { method: "POST", body: {} }), "小球奖池已冻结，可以开始逐奖抽取");
});
$("export-button").addEventListener("click", async () => {
  try {
    const data = await api("/api/admin/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `xlab-game-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    message("导出已完成；文件含个人资料和答卷，请仅交给核分负责人保管。");
  } catch (error) { message(error.message, true); }
});
async function boot() {
  try {
    await api("/api/admin/session");
    $("login-view").hidden = true;
    $("dashboard").hidden = false;
    $("admin-logout").hidden = false;
    await refresh();
  } catch {
    $("login-view").hidden = false;
  }
}
setInterval(() => void refresh(), 3000);
void boot();
