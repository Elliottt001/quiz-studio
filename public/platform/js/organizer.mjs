import { api } from "./api.mjs";
import { renderEditor } from "./editor.mjs";

const root = document.getElementById("organizer-app");
const params = new URLSearchParams(location.search);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function labeled(form, title, input) {
  const label = node("label", "form-field");
  label.append(node("span", "", title), input);
  form.append(label);
  return input;
}

function renderLogin(message = "") {
  const panel = node("section", "studio-panel nes-container is-rounded");
  panel.append(node("p", "eyebrow", "ORGANIZER / LOGIN"),
    node("h1", "pixel-heading", "进入游戏工坊"));
  const form = node("form", "form-stack");
  const username = labeled(form, "组织者账号", node("input", "nes-input"));
  username.name = "login";
  username.autocomplete = "username";
  username.required = true;
  const password = labeled(form, "密码", node("input", "nes-input"));
  password.type = "password";
  password.name = "password";
  password.autocomplete = "current-password";
  password.required = true;
  const status = node("p", "status-line", message);
  status.setAttribute("role", "status");
  const button = node("button", "nes-btn is-primary", "登录");
  button.type = "submit";
  form.append(button, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await api("/v2/auth/login", {
        method: "POST", body: { login: username.value, password: password.value }
      });
      await renderGames();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
  panel.append(form);
  root.replaceChildren(panel);
}

async function renderGames(message = "") {
  let games;
  try {
    games = (await api("/v2/games")).games;
  } catch (error) {
    if (error.status === 401) return renderLogin();
    root.replaceChildren(node("p", "status-line", error.message));
    return;
  }
  const panel = node("section", "studio-panel nes-container is-rounded");
  panel.append(node("p", "eyebrow", "YOUR GAMES / CREATE NEW"),
    node("h1", "pixel-heading", "你的游戏"));
  const actions = node("div", "toolbar");
  const create = node("button", "nes-btn is-primary", "创建游戏");
  create.type = "button";
  create.addEventListener("click", renderCreate);
  const logout = node("button", "nes-btn", "退出组织者");
  logout.type = "button";
  logout.addEventListener("click", async () => {
    try {
      await api("/v2/auth/logout", { method: "POST", body: {} });
      history.replaceState(null, "", "/organizer");
      renderLogin("已退出组织者账号");
    } catch (error) { panel.append(node("p", "status-line", error.message)); }
  });
  actions.append(create, logout);
  panel.append(actions);
  if (message) panel.append(node("p", "status-line", message));
  const list = node("div", "game-grid");
  for (const game of games) {
    const card = node("article", "game-tile");
    card.append(node("small", "eyebrow", game.status === "published" ? "LIVE" : "DRAFT"),
      node("h2", "pixel-subtitle", game.title),
      node("p", "readable", `入口标识：${game.slug}`));
    const open = node("button", "nes-btn", "进入游戏");
    open.type = "button";
    open.addEventListener("click", () => void openGame(game.id));
    card.append(open);
    list.append(card);
  }
  if (!games.length) list.append(node("p", "readable", "还没有游戏。从空白配置第一场。"));
  panel.append(list);
  root.replaceChildren(panel);
}

function renderCreate() {
  const panel = node("section", "studio-panel nes-container is-rounded");
  panel.append(node("p", "eyebrow", "LEVEL 01 / NEW GAME"),
    node("h1", "pixel-heading", "创建空白游戏"));
  const form = node("form", "form-stack");
  const slug = labeled(form, "游戏标识", node("input", "nes-input"));
  slug.name = "slug";
  slug.required = true;
  slug.pattern = "[a-z0-9-]{3,48}";
  slug.placeholder = "science-night";
  const title = labeled(form, "游戏名称", node("input", "nes-input"));
  title.name = "title";
  title.required = true;
  title.maxLength = 120;
  const status = node("p", "status-line");
  status.setAttribute("role", "status");
  const actions = node("div", "toolbar");
  const submit = node("button", "nes-btn is-primary", "创建空白游戏");
  submit.type = "submit";
  const back = node("button", "nes-btn", "返回游戏列表");
  back.type = "button";
  back.addEventListener("click", () => void renderGames());
  actions.append(submit, back);
  form.append(actions, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const game = await api("/v2/games", {
        method: "POST", body: { slug: slug.value, title: title.value }
      });
      await openGame(game.id);
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });
  panel.append(form);
  root.replaceChildren(panel);
}

async function sendGameAction(gameId, action) {
  const base = `/v2/games/${gameId}`;
  if (action.type === "details") {
    return api(`${base}/details`, { method: "PATCH", body: action.body });
  }
  if (action.type === "round") {
    return api(action.body.roundId
      ? `${base}/rounds/${action.body.roundId}` : `${base}/rounds`, {
      method: action.body.roundId ? "PUT" : "POST", body: action.body
    });
  }
  if (action.type === "delete") {
    return api(`${base}/rounds/${action.roundId}`, {
      method: "DELETE", body: { expectedVersion: action.expectedVersion }
    });
  }
  if (action.type === "reorder") {
    return api(`${base}/rounds/order`, { method: "PATCH", body: action.body });
  }
  if (action.type === "publish") {
    return api(`${base}/publish`, { method: "POST", body: {} });
  }
  if (action.type === "start") {
    return api(`${base}/rounds/${action.roundId}/start`, { method: "POST", body: {} });
  }
  if (action.type === "invite") {
    return api(`${base}/members`, { method: "POST", body: { login: action.login } });
  }
  if (action.type === "void") {
    return api(`${base}/questions/${action.questionId}/void`, {
      method: "POST", body: { reason: action.reason }
    });
  }
  throw new Error("操作类型无效");
}

async function openGame(id, options = {}) {
  try {
    const snapshot = await api(`/v2/games/${id}/editor`);
    history.replaceState(null, "", `/organizer?game=${id}`);
    renderEditor(root, snapshot, (action) => sendGameAction(id, action), options);
  } catch (error) {
    root.replaceChildren(node("p", "status-line", error.message));
  }
}

async function boot() {
  try {
    const { authenticated } = await api("/v2/auth/status");
    if (!authenticated) return renderLogin();
    const gameId = params.get("game");
    if (gameId) await openGame(gameId);
    else await renderGames();
  } catch (error) {
    root.replaceChildren(node("p", "status-line", error.message));
  }
}

void boot();
