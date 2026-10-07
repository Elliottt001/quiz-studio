import { api, remainingLabel, teamNames } from "./api.mjs";

const $ = (id) => document.getElementById(id);
const views = ["register", "lobby", "quiz", "results"];
let player = null;
let gameState = null;
let standings = [];
let serverOffset = 0;
let currentRound = null;
let currentQuestions = [];
let answers = {};
let pendingKey = null;
let pendingAnswers = null;
let draftTimer = null;
let showingResultsFor = null;

function view(name) {
  for (const item of views) $(`${item}-view`).hidden = item !== name;
  window.scrollTo({ top: 0, behavior: "instant" });
}

function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setPlayer(profile) {
  player = profile;
  $("lobby-title").textContent = profile.nickname;
  $("real-name-label").textContent = profile.realName;
  $("player-id-label").textContent = `ID ${profile.id.slice(0, 8).toUpperCase()}`;
  $("grade-label").textContent = `${profile.grade} 级`;
  $("team-label").textContent = teamNames[profile.team] ?? profile.team;
  view("lobby");
  void refresh();
}

async function loadPlayer() {
  try {
    setPlayer(await api("/api/me"));
  } catch (error) {
    if (error.status !== 401) notice(error.message);
    view("register");
  }
}

function renderLobby() {
  if (!player || !gameState) return;
  const mine = standings.find((entry) => entry.id === player.id);
  $("total-score").textContent = mine?.score ?? 0;
  $("ball-label").textContent = `预计 ${10 + (mine?.score ?? 0) / 10} 颗球`;
  const completed = gameState.rounds.filter((round) => round.status === "published").length;
  $("progress-label").textContent = `${completed} / 4 已完成`;
  const list = $("round-list");
  list.replaceChildren();
  for (const round of gameState.rounds) {
    const card = element("article", `round-card${round.status === "open" ? " is-live" : ""}`);
    card.append(element("div", "round-number", String(round.id).padStart(2, "0")));
    const detail = element("div", "round-text");
    detail.append(element("strong", "", round.title));
    detail.append(element("small", "", `${[6, 10, 9, 5][round.id - 1]} 题 · 5 分钟`));
    card.append(detail);
    const label = { prepared: "尚未解锁", open: "正在进行", settling: "结算中", published: "已完成", voided: "已作废" };
    if (round.status === "open") {
      const button = element("button", "round-open", "进入 ↗");
      button.type = "button";
      button.addEventListener("click", () => void openRound(round.id));
      card.append(button);
    } else {
      card.append(element("span", "round-status", label[round.status] ?? round.status));
    }
    list.append(card);
  }
}

function updateTimer() {
  if (!currentRound) return;
  const left = currentRound.deadlineAt - (Date.now() + serverOffset);
  $("timer").textContent = remainingLabel(left);
  $("timer").classList.toggle("is-urgent", left <= 30_000);
  if (left <= 0) {
    $("submit-button").disabled = true;
    $("submit-state").textContent = "答题截止 · 等待结算";
  }
}

function answeredCount() {
  $("answered-count").textContent = `已答 ${Object.keys(answers).filter((id) =>
    typeof answers[id] === "number" || String(answers[id] ?? "").trim().length > 0
  ).length} / ${currentQuestions.length} 题`;
}

function changed() {
  pendingKey = null;
  pendingAnswers = null;
  $("submit-state").textContent = "草稿待保存 · 尚未提交";
  answeredCount();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    try {
      await api(`/api/rounds/${currentRound.id}/draft`, { method: "PUT", body: { answers: { ...answers } } });
      $("submit-state").textContent = "草稿已保存 · 尚未提交";
    } catch (error) {
      $("submit-state").textContent = "草稿尚未同步";
      notice(error.message);
    }
  }, 350);
}

function drawQuestions(questions) {
  const list = $("question-list");
  list.replaceChildren();
  questions.forEach((question) => {
    const card = element("article", "question");
    const head = element("div", "question-head");
    head.append(element("span", "", String(question.position).padStart(2, "0")));
    head.append(element("h3", "", question.prompt));
    card.append(head);
    if (question.kind === "choice") {
      const options = element("div", "choices");
      question.options.forEach((option, index) => {
        const label = element("label", "choice");
        const input = element("input");
        input.type = "radio";
        input.name = question.id;
        input.value = String(index);
        input.checked = answers[question.id] === index;
        input.addEventListener("change", () => { answers[question.id] = index; changed(); });
        label.append(input, element("span", "choice-letter", String.fromCharCode(65 + index)), element("span", "", option));
        options.append(label);
      });
      card.append(options);
    } else {
      const input = element("textarea", "reflection-input");
      input.placeholder = "写下你的感受或想法；未亲历训练营，也可以写听后的感受。";
      input.value = answers[question.id] ?? "";
      const count = element("p", "reflection-count");
      const update = () => {
        answers[question.id] = input.value;
        count.textContent = `${Array.from(input.value.trim()).length} / 120 字 · 5–120 字成功提交即得 10 分`;
        changed();
      };
      input.addEventListener("input", update);
      count.textContent = `${Array.from(input.value.trim()).length} / 120 字 · 5–120 字成功提交即得 10 分`;
      card.append(input, count);
    }
    list.append(card);
  });
  answeredCount();
}

async function openRound(id) {
  try {
    const [data, mine] = await Promise.all([
      api(`/api/rounds/${id}`), api(`/api/rounds/${id}/my`)
    ]);
    if (data.round.status !== "open") return;
    currentRound = data.round;
    currentQuestions = data.questions;
    answers = { ...(mine.draft?.answers ?? {}) };
    pendingKey = null;
    showingResultsFor = null;
    $("quiz-kicker").textContent = `SIDE QUEST 0${id} / 04`;
    $("quiz-title").textContent = data.round.title;
    $("submit-state").textContent = mine.submission ? `提交成功 · 第 ${mine.submission.revision} 次交卷` : "尚未提交";
    $("submit-button").disabled = false;
    drawQuestions(data.questions);
    view("quiz");
    updateTimer();
  } catch (error) { notice(error.message); }
}

async function submitRound() {
  if (!currentRound || $("submit-button").disabled) return;
  clearTimeout(draftTimer);
  pendingKey ??= crypto.randomUUID();
  pendingAnswers ??= { ...answers };
  $("submit-button").disabled = true;
  $("submit-state").textContent = "正在提交 · 请勿关闭页面";
  try {
    const receipt = await api(`/api/rounds/${currentRound.id}/submit`, {
      method: "POST",
      body: { answers: pendingAnswers, requestKey: pendingKey }
    });
    $("submit-state").textContent = `提交成功 · 第 ${receipt.revision} 次交卷`;
    $("submit-button").disabled = false;
    notice("");
  } catch (error) {
    $("submit-state").textContent = "尚未确认提交 · 可重试";
    $("submit-button").disabled = false;
    notice(error.message);
  }
}

function renderLeaderboard() {
  const list = $("leaderboard");
  list.replaceChildren();
  const top = standings.slice(0, 10);
  const me = standings.find((entry) => entry.id === player?.id);
  if (me && !top.some((entry) => entry.id === me.id)) top.push(me);
  $("my-rank").textContent = me ? `我的排名 #${me.rank}` : "";
  for (const entry of top) {
    const row = element("li", entry.id === player?.id ? "is-me" : "");
    row.append(element("span", "rank", String(entry.rank).padStart(2, "0")));
    const name = element("span", "board-name", entry.nickname);
    name.append(element("small", "", entry.realName));
    row.append(name, element("strong", "board-score", String(entry.score)));
    list.append(row);
  }
}

async function showResults(id) {
  if (!player) return;
  showingResultsFor = id;
  try {
    const [mine, data, standing] = await Promise.all([
      api(`/api/rounds/${id}/my`), api(`/api/rounds/${id}`), api("/api/standings")
    ]);
    standings = standing.players;
    $("results-round").textContent = `SIDE QUEST 0${id}`;
    $("round-score").textContent = mine.score?.points ?? "…";
    $("results-status").textContent = mine.score
      ? "成绩已公布。答题积分将计入最后的虚拟小球奖池。"
      : mine.submission ? "答卷已确认，系统正在结算。" : "本轮没有成功提交的答卷。";
    const summary = $("answer-summary");
    summary.replaceChildren();
    if (mine.score) {
      for (const question of data.questions) {
        const row = element("div", "answer-row");
        row.append(element("span", "", `第 ${question.position} 题 · ${question.explanation || question.prompt}`));
        row.append(element("em", "", `+${mine.score.detail[question.id] ?? 0}`));
        summary.append(row);
      }
    }
    renderLeaderboard();
    view("results");
  } catch (error) { notice(error.message); }
}

async function refresh() {
  if (!player) return;
  try {
    const [state, board] = await Promise.all([api("/api/state"), api("/api/standings")]);
    serverOffset = state.serverTime - Date.now();
    gameState = state;
    standings = board.players;
    const live = state.rounds.find((round) => round.status === "open");
    $("hero-status").textContent = live ? `第 0${live.id} 轮正在进行` : "等待下一关开启";
    if (live && (!currentRound || currentRound.id !== live.id)) {
      await openRound(live.id);
    } else if (currentRound && state.rounds[currentRound.id - 1].status === "published"
      && showingResultsFor !== currentRound.id) {
      await showResults(currentRound.id);
    } else if (!$("lobby-view").hidden) renderLobby();
    else if (!$("results-view").hidden) renderLeaderboard();
  } catch (error) {
    notice(`连接中断：${error.message}。已确认的交卷不会丢失，正在重试。`);
  }
}

$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    await api("/api/players", { method: "POST", body: { ...fields, grade: Number(fields.grade) } });
    setPlayer(await api("/api/me"));
    notice("");
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$("recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { code } = Object.fromEntries(new FormData(event.currentTarget));
    await api("/api/players/recover", { method: "POST", body: { code } });
    setPlayer(await api("/api/me"));
    notice("");
  } catch (error) { notice(error.message); }
});
$("submit-button").addEventListener("click", () => void submitRound());
$("practice-button").addEventListener("click", () => { $("practice-panel").hidden = !$("practice-panel").hidden; });
document.querySelectorAll("[data-practice]").forEach((button) => button.addEventListener("click", () => {
  $("practice-feedback").textContent = button.dataset.practice === "4" ? "正确！练习不计入正式成绩。" : "再试一次：这场游戏共有四轮。";
}));
$("standings-button").addEventListener("click", () => {
  const last = gameState?.rounds.filter((round) => round.status === "published").at(-1)?.id;
  void showResults(last ?? 1);
});
$("back-to-lobby").addEventListener("click", () => { view("lobby"); renderLobby(); });
setInterval(updateTimer, 250);
setInterval(() => void refresh(), 3000);
void loadPlayer();
