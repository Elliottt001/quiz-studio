import { api } from "./api.mjs";
import {
  draftStorageKey, pendingStorageKey, createPendingSubmission,
  clearPendingSubmission, clearPlayerStorage
} from "./submission.mjs";

const root = document.getElementById("player-app");
const slug = location.pathname.split("/")[2];
const base = `/v2/games/${slug}`;
let registration = null;
let player = null;
let state = null;
let view = "join";
let round = null;
let questions = [];
let answers = {};
let offset = 0;
let busy = false;
let draftTimer = null;
let lastServerDraft = 0;
let refreshTimer = null;
let sessionGeneration = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(parent, labelText, tag = "input") {
  const label = node("label", "form-field");
  const control = node(tag, tag === "textarea" ? "nes-textarea" : "nes-input");
  label.append(node("span", "", labelText), control);
  parent.append(label);
  return control;
}

function button(text, className = "nes-btn") {
  const control = node("button", className, text);
  control.type = "button";
  return control;
}

function panel(kicker, heading) {
  const section = node("section", "studio-panel nes-container is-rounded");
  section.append(node("p", "eyebrow", kicker), node("h1", "pixel-heading", heading));
  return section;
}

function message(target, text) {
  target.textContent = text;
  target.setAttribute("role", "status");
}

function renderJoin(mode = "register", initial = "") {
  view = "join";
  const area = panel("JOIN / NEW PLAYER", registration.game.title);
  area.append(node("p", "readable", registration.game.description));
  const status = node("p", "status-line");
  message(status, initial);
  const form = node("form", "form-stack");
  const actions = node("div", "toolbar");
  if (mode === "register") {
    const name = field(form, "展示名");
    name.name = "displayName";
    name.required = true;
    name.maxLength = 40;
    const password = field(form, "密码");
    password.type = "password";
    password.name = "password";
    password.minLength = 10;
    password.required = true;
    const profileInputs = new Map();
    for (const config of registration.fields) {
      const label = node("label", "form-field");
      label.append(node("span", "", config.label));
      let control;
      if (config.type === "select") {
        control = node("select", "nes-select");
        control.append(new Option("请选择", ""));
        for (const option of config.options) control.append(new Option(option, option));
      } else {
        control = node("input", "nes-input");
        control.maxLength = config.maxLength;
      }
      control.required = config.required;
      label.append(control);
      form.append(label);
      profileInputs.set(config.key, control);
    }
    const submit = button("加入游戏", "nes-btn is-primary");
    submit.type = "submit";
    const login = button("已有账号，去登录");
    login.addEventListener("click", () => renderJoin("login"));
    const recover = button("我有恢复码");
    recover.addEventListener("click", () => renderJoin("recover"));
    actions.append(submit, login, recover);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const profile = Object.fromEntries([...profileInputs].map(([key, input]) =>
          [key, input.value]));
        await api(`${base}/players`, {
          method: "POST", body: {
            displayName: name.value, password: password.value, profile
          }
        });
        await loadPlayer();
      } catch (error) {
        message(status, error.path ? `${error.path}：${error.message}` : error.message);
        submit.disabled = false;
      }
    });
  } else if (mode === "login") {
    const code = field(form, "登录码");
    code.autocomplete = "username";
    code.required = true;
    const password = field(form, "密码");
    password.type = "password";
    password.autocomplete = "current-password";
    password.required = true;
    const submit = button("登录", "nes-btn is-primary");
    submit.type = "submit";
    const back = button("返回注册");
    back.addEventListener("click", () => renderJoin());
    const recover = button("我有恢复码");
    recover.addEventListener("click", () => renderJoin("recover"));
    actions.append(submit, back, recover);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await api(`${base}/login`, { method: "POST",
          body: { loginCode: code.value, password: password.value } });
        await loadPlayer();
      } catch (error) { message(status, error.message); submit.disabled = false; }
    });
  } else {
    const code = field(form, "恢复码");
    code.required = true;
    const password = field(form, "新密码");
    password.type = "password";
    password.minLength = 10;
    password.required = true;
    const submit = button("恢复原账号", "nes-btn is-primary");
    submit.type = "submit";
    const back = button("返回注册");
    back.addEventListener("click", () => renderJoin());
    actions.append(submit, back);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await api(`${base}/recover`, {
          method: "POST", body: { code: code.value, password: password.value }
        });
        await loadPlayer();
      } catch (error) { message(status, error.message); submit.disabled = false; }
    });
  }
  form.append(actions, status);
  area.append(form);
  root.replaceChildren(area);
}

async function logout() {
  if (!player) return;
  const previous = player;
  try {
    await api(`${base}/logout`, { method: "POST", body: {} });
    clearPlayerStorage(sessionStorage, slug, previous.id);
    sessionGeneration++;
    clearTimeout(refreshTimer);
    clearTimeout(draftTimer);
    player = null;
    state = null;
    round = null;
    answers = {};
    renderJoin("register", "已退出账号。公用电脑可由下一位玩家加入。");
  } catch (error) {
    const status = root.querySelector('[role="status"]');
    if (status) message(status, `退出未确认：${error.message}`);
  }
}

function frame(kicker, heading) {
  const area = panel(kicker, heading);
  const identity = node("div", "player-identity");
  identity.append(node("strong", "", player.displayName));
  const exit = button("退出账号");
  exit.addEventListener("click", () => void logout());
  identity.append(exit);
  area.append(identity);
  return area;
}

function renderLobby() {
  if (!player || !state) return;
  view = "lobby";
  const area = frame("GAME / LOBBY", state.game.title);
  const code = node("p", "readable");
  code.append(node("span", "", "登录码 "), node("code", "", player.loginCode));
  area.append(code, node("p", "readable", state.game.description));
  const list = node("div", "round-list");
  for (const item of state.rounds) {
    const card = node("article", "round-row");
    card.append(node("strong", "", `第 ${item.position} 轮 · ${item.title}`),
      node("small", "", `${item.questionCount} 题 · ${item.durationMs / 60_000} 分钟`));
    if (item.status === "open") {
      const enter = button(`进入第 ${item.position} 轮`, "nes-btn is-primary");
      enter.addEventListener("click", () => void openRound(item.id));
      card.append(enter);
    } else if (item.status === "published") {
      const result = button(`查看第 ${item.position} 轮成绩`);
      result.addEventListener("click", () => void showResults(item.id));
      card.append(result);
    } else {
      card.append(node("span", "round-state", "待开启"));
    }
    list.append(card);
  }
  if (!state.rounds.length) list.append(node("p", "readable", "等待组织者配置游戏"));
  area.append(list);
  root.replaceChildren(area);
}

function localDraftKey() {
  return draftStorageKey(slug, player.id, round.id);
}

function restoreAnswers(mine) {
  let local;
  try { local = JSON.parse(sessionStorage.getItem(localDraftKey())); } catch {}
  if (local?.answers && local.savedAt > (mine.draft?.savedAt ?? 0)
    && local.savedAt > (mine.submission?.submittedAt ?? 0)) {
    return local.answers;
  }
  if (mine.draft?.savedAt > (mine.submission?.submittedAt ?? 0)) return mine.draft.answers;
  return mine.submission?.answers ?? mine.draft?.answers ?? {};
}

function saveLocalDraft() {
  if (!round || !player) return;
  sessionStorage.setItem(localDraftKey(), JSON.stringify({
    answers, savedAt: Date.now() + offset
  }));
}

async function saveServerDraft(force = false) {
  if (!round || !player || view !== "quiz" || busy) return;
  const now = Date.now();
  if (!force && now - lastServerDraft < 15_000) return;
  lastServerDraft = now;
  const snapshot = structuredClone(answers);
  try {
    await api(`${base}/rounds/${round.id}/draft`, {
      method: "PUT", body: { answers: snapshot }
    });
    const status = document.getElementById("submit-status");
    if (status && !status.textContent.startsWith("提交成功")) {
      message(status, "草稿已保存 · 尚未正式交卷");
    }
  } catch {
    const status = document.getElementById("submit-status");
    if (status && !status.textContent.startsWith("提交成功")) {
      message(status, "草稿暂未同步，仍保存在本机");
    }
  }
}

function changed() {
  saveLocalDraft();
  clearPendingSubmission(sessionStorage, slug, player.id, round.id);
  const status = document.getElementById("submit-status");
  if (status) message(status, "修改尚未提交 · 仅保存了草稿");
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void saveServerDraft(), 350);
  updateTimer();
}

function questionCard(question) {
  const card = node("fieldset", "play-question");
  card.append(node("legend", "question-title", `${question.position}. ${question.prompt}`));
  if (question.kind === "choice" || question.kind === "multiple") {
    for (const [index, option] of question.options.entries()) {
      const label = node("label", "answer-option");
      const input = node("input");
      input.type = question.kind === "choice" ? "radio" : "checkbox";
      input.name = question.id;
      input.value = String(index);
      input.checked = question.kind === "choice"
        ? answers[question.id] === index
        : (answers[question.id] ?? []).includes(index);
      input.addEventListener("change", () => {
        if (question.kind === "choice") answers[question.id] = index;
        else answers[question.id] = [...card.querySelectorAll("input:checked")]
          .map((control) => Number(control.value));
        changed();
      });
      label.append(input, node("span", "", option));
      card.append(label);
    }
  } else {
    const label = node("label", "form-field");
    label.append(node("span", "", question.prompt));
    const input = node(question.kind === "length" ? "textarea" : "input",
      question.kind === "length" ? "nes-textarea" : "nes-input");
    input.value = answers[question.id] ?? "";
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => {
      composing = false;
      answers[question.id] = input.value;
      changed();
    });
    input.addEventListener("input", () => {
      if (composing) return;
      answers[question.id] = input.value;
      changed();
    });
    label.append(input);
    card.append(label);
    if (question.kind === "length") {
      card.append(node("p", "help", `${question.answerRule.minLength}–${question.answerRule.maxLength} 字即得 ${question.points} 分`));
    }
  }
  return card;
}

function updateTimer() {
  if (!round || view !== "quiz") return;
  const left = round.deadlineAt - (Date.now() + offset);
  const seconds = Math.max(0, Math.ceil(left / 1000));
  const display = document.getElementById("round-timer");
  if (display) {
    display.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${
      String(seconds % 60).padStart(2, "0")}`;
  }
  const submit = document.getElementById("submit-answers");
  if (submit) {
    const pending = sessionStorage.getItem(pendingStorageKey(slug, player.id, round.id));
    submit.disabled = busy || (left <= 0 && !pending);
    if (left <= 0 && !pending) {
      const status = document.getElementById("submit-status");
      if (status && !status.textContent.startsWith("提交成功")) {
        message(status, "本轮已截止，等待收卷公布");
      }
    }
  }
}

async function submitRound() {
  if (!round || !player || busy) return;
  clearTimeout(draftTimer);
  const pending = createPendingSubmission({
    gameId: slug, playerId: player.id, roundId: round.id, answers
  }, sessionStorage);
  busy = true;
  const status = document.getElementById("submit-status");
  message(status, "正在提交 · 尚未收到回执");
  updateTimer();
  try {
    const receipt = await api(`${base}/rounds/${round.id}/submit`, {
      method: "POST", body: pending, timeoutMs: 12_000
    });
    message(status, JSON.stringify(answers) === JSON.stringify(pending.answers)
      ? `提交成功 · 回执 ${receipt.id}` : `提交成功 · 回执 ${receipt.id}；当前修改尚未提交`);
  } catch (error) {
    message(status, error.status === 409
      ? `未确认，可重试原提交：${error.message}`
      : "未确认，可重试原提交");
  } finally {
    busy = false;
    updateTimer();
  }
}

async function openRound(id) {
  try {
    const [data, mine] = await Promise.all([
      api(`${base}/rounds/${id}`), api(`${base}/rounds/${id}/my`)
    ]);
    if (data.round.status !== "open") return;
    round = data.round;
    questions = data.questions;
    answers = restoreAnswers(mine);
    view = "quiz";
    const area = frame(`ROUND ${round.position} / PLAY`, round.title);
    const timer = node("strong", "pixel-timer", "00:00");
    timer.id = "round-timer";
    area.append(timer);
    const list = node("div", "play-questions");
    for (const question of questions) list.append(questionCard(question));
    area.append(list);
    const status = node("p", "status-line",
      mine.submission ? `已确认第 ${mine.submission.revision} 次交卷` : "草稿尚未交卷");
    status.id = "submit-status";
    status.setAttribute("role", "status");
    const send = button("提交答卷", "nes-btn is-primary");
    send.id = "submit-answers";
    send.addEventListener("click", () => void submitRound());
    const back = button("返回大厅");
    back.addEventListener("click", renderLobby);
    area.append(status, send, back);
    root.replaceChildren(area);
    updateTimer();
  } catch (error) {
    root.replaceChildren(node("p", "status-line", error.message));
  }
}

async function showResults(id) {
  if (!player) return;
  try {
    const [mine, board, details] = await Promise.all([
      api(`${base}/rounds/${id}/my`),
      api(`${base}/standings`),
      api(`${base}/rounds/${id}`)
    ]);
    view = "results";
    round = null;
    const area = frame("RESULT / SCORE", details.round.title);
    area.append(node("strong", "round-score",
      mine.score === null ? "成绩结算中" : `本轮得分 ${mine.score}`));
    const list = node("ol", "score-board");
    for (const entry of board.players.slice(0, 10)) {
      const item = node("li", "score-row");
      item.append(node("span", "", `${entry.rank}. ${entry.displayName}`),
        node("strong", "", String(entry.score)));
      list.append(item);
    }
    const back = button("返回大厅");
    back.addEventListener("click", renderLobby);
    area.append(list, back);
    root.replaceChildren(area);
  } catch (error) {
    root.replaceChildren(node("p", "status-line", error.message));
  }
}

async function refreshState(generation) {
  if (!player || generation !== sessionGeneration) return;
  try {
    state = await api(`${base}/state`);
    offset = state.serverTime - Date.now();
    if (view === "lobby") renderLobby();
    else if (view === "quiz" && round) {
      const current = state.rounds.find((item) => item.id === round.id);
      if (current?.status === "published") await showResults(round.id);
      else updateTimer();
    }
  } catch {
    const status = root.querySelector('[role="status"]');
    if (status && view !== "join") message(status, "连接中断，正在重试；未确认交卷不会计分");
  } finally {
    if (player && generation === sessionGeneration) {
      refreshTimer = setTimeout(() => void refreshState(generation),
        2000 + Math.round(Math.random() * 500));
    }
  }
}

async function loadPlayer() {
  player = await api(`${base}/me`);
  sessionGeneration++;
  clearTimeout(refreshTimer);
  state = await api(`${base}/state`);
  offset = state.serverTime - Date.now();
  renderLobby();
  void refreshState(sessionGeneration);
}

async function boot() {
  try {
    registration = await api(`${base}/registration`);
    const { authenticated } = await api(`${base}/session`);
    if (authenticated) await loadPlayer();
    else renderJoin();
  } catch (error) {
    root.replaceChildren(node("p", "status-line", error.message));
  }
}

setInterval(updateTimer, 250);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void saveServerDraft(true);
});
window.addEventListener("blur", () => void saveServerDraft(true));
void boot();
