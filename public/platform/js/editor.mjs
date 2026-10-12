import { api } from "./api.mjs";

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(parent, labelText, tag = "input", className = "nes-input") {
  const label = node("label", "form-field");
  const caption = node("span", "", labelText);
  const control = node(tag, className);
  label.append(caption, control);
  parent.append(label);
  return control;
}

function button(label, className = "nes-btn") {
  const item = node("button", className, label);
  item.type = "button";
  return item;
}

function fieldRow(container, entry = {}) {
  const row = node("div", "field-row");
  row.dataset.fieldRow = "1";
  const key = field(row, "字段键");
  key.value = entry.key ?? "";
  key.dataset.field = "key";
  const name = field(row, "字段名称");
  name.value = entry.label ?? "";
  name.dataset.field = "label";
  const kind = field(row, "字段类型", "select", "nes-select");
  kind.append(new Option("短文本", "text"), new Option("选项", "select"));
  kind.value = entry.type ?? "text";
  kind.dataset.field = "type";
  const requiredLabel = node("label", "check-field");
  const required = node("input");
  required.type = "checkbox";
  required.checked = entry.required ?? false;
  required.dataset.field = "required";
  requiredLabel.append(required, node("span", "", "必填"));
  row.append(requiredLabel);
  const optionWrap = node("div", "field-options");
  const options = field(optionWrap, "选项（每行一个）", "textarea", "nes-textarea");
  options.value = (entry.options ?? []).join("\n");
  options.dataset.field = "options";
  const textWrap = node("div", "field-length");
  const min = field(textWrap, "最少字数");
  min.type = "number";
  min.min = "0";
  min.max = "120";
  min.value = entry.minLength ?? 0;
  min.dataset.field = "min";
  const max = field(textWrap, "最多字数");
  max.type = "number";
  max.min = "1";
  max.max = "120";
  max.value = entry.maxLength ?? 120;
  max.dataset.field = "max";
  const help = field(row, "帮助文字");
  help.value = entry.help ?? "";
  help.dataset.field = "help";
  const remove = button("移除字段", "nes-btn is-error");
  remove.addEventListener("click", () => row.remove());
  row.append(optionWrap, textWrap, remove);
  function update() {
    optionWrap.hidden = kind.value !== "select";
    textWrap.hidden = kind.value !== "text";
  }
  kind.addEventListener("change", update);
  update();
  container.append(row);
}

function readFields(container) {
  return [...container.querySelectorAll("[data-field-row]")].map((row) => {
    const value = (name) => row.querySelector(`[data-field="${name}"]`);
    const common = {
      key: value("key").value.trim(),
      label: value("label").value.trim(),
      type: value("type").value,
      required: value("required").checked,
      help: value("help").value.trim()
    };
    return common.type === "select"
      ? { ...common, options: value("options").value.split(/\r?\n/).map((item) => item.trim())
        .filter(Boolean) }
      : { ...common, minLength: Number(value("min").value),
        maxLength: Number(value("max").value) };
  });
}

function questionCard(container, kind, entry = {}) {
  const card = node("article", "question-editor nes-container is-rounded");
  card.dataset.questionKind = kind;
  const names = { choice: "单选", multiple: "多选", exact: "标准答案填空", length: "开放填写" };
  card.append(node("h3", "pixel-subtitle", names[kind]));
  const prompt = field(card, "题干", "textarea", "nes-textarea");
  prompt.dataset.questionField = "prompt";
  prompt.value = entry.prompt ?? "";
  const points = field(card, "分值");
  points.type = "number";
  points.min = "0";
  points.max = "10000";
  points.value = entry.points ?? 10;
  points.dataset.questionField = "points";
  if (kind === "choice" || kind === "multiple") {
    const options = field(card, "选项（每行一个）", "textarea", "nes-textarea");
    options.value = (entry.options ?? ["", ""]).join("\n");
    options.dataset.questionField = "options";
    const correct = field(card, kind === "choice"
      ? "正确选项序号" : "正确选项序号（逗号分隔）");
    correct.value = kind === "choice"
      ? String((entry.answerRule?.correctOption ?? 0) + 1)
      : (entry.answerRule?.correctOptions ?? [0]).map((index) => index + 1).join(",");
    correct.dataset.questionField = "correct";
    if (kind === "choice") correct.type = "number";
  } else if (kind === "exact") {
    const accepted = field(card, "可接受答案（每行一个）", "textarea", "nes-textarea");
    accepted.value = (entry.answerRule?.accepted ?? []).join("\n");
    accepted.dataset.questionField = "accepted";
  } else {
    const min = field(card, "最少字数");
    min.type = "number";
    min.min = "1";
    min.max = "120";
    min.value = entry.answerRule?.minLength ?? 5;
    min.dataset.questionField = "min";
    const max = field(card, "最多字数");
    max.type = "number";
    max.min = "1";
    max.max = "120";
    max.value = entry.answerRule?.maxLength ?? 120;
    max.dataset.questionField = "max";
  }
  const remove = button("移除这道题", "nes-btn is-error");
  remove.addEventListener("click", () => card.remove());
  card.append(remove);
  container.append(card);
}

function readQuestions(container) {
  return [...container.querySelectorAll("[data-question-kind]")].map((card, index) => {
    const value = (name) => card.querySelector(`[data-question-field="${name}"]`)?.value ?? "";
    const kind = card.dataset.questionKind;
    const common = { position: index + 1, kind, prompt: value("prompt").trim(),
      points: Number(value("points")) };
    if (kind === "choice" || kind === "multiple") {
      const options = value("options").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const answerRule = kind === "choice"
        ? { correctOption: Number(value("correct")) - 1 }
        : { correctOptions: value("correct").split(",").map((item) => Number(item.trim()) - 1) };
      return { ...common, options, answerRule };
    }
    if (kind === "exact") return { ...common,
      answerRule: { accepted: value("accepted").split(/\r?\n/)
        .map((item) => item.trim()).filter(Boolean) } };
    return { ...common, answerRule: {
      minLength: Number(value("min")), maxLength: Number(value("max"))
    } };
  });
}

export function renderEditor(root, snapshot, onSave, options = {}) {
  root.replaceChildren();
  const owner = snapshot.role === "owner";
  const editable = owner && snapshot.game.status === "draft";
  let version = snapshot.version;
  let step = options.step ?? "basic";
  const title = node("h1", "pixel-heading", snapshot.game.title);
  const kicker = node("p", "eyebrow",
    `${snapshot.game.status === "published" ? "LIVE" : "DRAFT"} / ${snapshot.game.slug}`);
  const summary = node("div", "round-chips");
  for (const round of snapshot.rounds) summary.append(node("span", "round-chip", round.title));
  const status = node("p", "status-line", options.message ?? "");
  status.setAttribute("role", "status");
  const nav = node("nav", "step-nav");
  const sections = {};
  for (const [key, label] of [
    ["basic", "基本信息"], ["fields", "报名字段"], ["rounds", "轮次题目"],
    ["preview", "预览发布"], ["control", "控制台"]
  ]) {
    const tab = button(label, "step-button");
    tab.addEventListener("click", () => activate(key));
    nav.append(tab);
    const section = node("section", "studio-panel nes-container is-rounded");
    section.dataset.step = key;
    sections[key] = section;
  }
  function activate(name) {
    step = name;
    for (const [key, section] of Object.entries(sections)) section.hidden = key !== name;
    for (const child of nav.children) {
      child.classList.toggle("is-active", child.textContent === {
        basic: "基本信息", fields: "报名字段", rounds: "轮次题目",
        preview: "预览发布", control: "控制台"
      }[name]);
    }
  }
  const refresh = async (name, message) => {
    const updated = await api(`/v2/games/${snapshot.game.id}/editor`);
    renderEditor(root, updated, onSave, { step: name, message });
  };
  const perform = async (operation, success, name = step) => {
    status.textContent = "正在保存…";
    try {
      const result = await onSave(operation);
      await refresh(name, success(result));
      return result;
    } catch (error) {
      status.textContent = error.status === 409 && error.currentVersion
        ? "版本冲突，当前输入仍保留"
        : error.path ? `${error.path}：${error.message}` : error.message;
      return null;
    }
  };
  root.append(kicker, title, summary, nav, status,
    sections.basic, sections.fields, sections.rounds, sections.preview, sections.control);

  const gameName = field(sections.basic, "游戏名称");
  gameName.value = snapshot.game.title;
  gameName.disabled = !editable;
  const description = field(sections.basic, "游戏介绍", "textarea", "nes-textarea");
  description.value = snapshot.description;
  description.disabled = !editable;
  const boardLabel = node("label", "check-field");
  const leaderboard = node("input");
  leaderboard.type = "checkbox";
  leaderboard.checked = snapshot.leaderboard;
  leaderboard.disabled = !editable;
  boardLabel.append(leaderboard, node("span", "", "公布榜单"));
  sections.basic.append(boardLabel);

  sections.fields.append(node("h2", "pixel-subtitle", "报名字段"));
  const fieldList = node("div", "field-list");
  for (const entry of snapshot.fields) fieldRow(fieldList, entry);
  sections.fields.append(fieldList);
  if (editable) {
    const addField = button("添加报名字段", "nes-btn");
    addField.addEventListener("click", () => fieldRow(fieldList));
    sections.fields.append(addField);
    const save = button("保存草稿", "nes-btn is-primary");
    save.addEventListener("click", () => {
      save.disabled = true;
      void perform({
        type: "details",
        body: { expectedVersion: version, title: gameName.value,
          description: description.value, leaderboard: leaderboard.checked,
          fields: readFields(fieldList) }
      }, (result) => `已保存 · 版本 ${result.version}`).finally(() => { save.disabled = false; });
    });
    root.insertBefore(save, sections.basic);
  } else {
    fieldList.querySelectorAll("input,select,textarea,button").forEach((control) => {
      control.disabled = true;
    });
  }

  sections.rounds.append(node("h2", "pixel-subtitle", "轮次与题目"));
  const roundList = node("div", "round-list");
  sections.rounds.append(roundList);
  const showRoundForm = (entry = null) => {
    const existing = sections.rounds.querySelector("[data-round-form]");
    existing?.remove();
    const form = node("div", "round-form");
    form.dataset.roundForm = "1";
    const name = field(form, "轮次标题");
    name.value = entry?.title ?? "";
    const duration = field(form, "作答时长（分钟）");
    duration.type = "number";
    duration.min = ".5";
    duration.max = "60";
    duration.step = ".5";
    duration.value = String((entry?.durationMs ?? 300_000) / 60_000);
    const questions = node("div", "question-list");
    for (const q of entry?.questions ?? []) questionCard(questions, q.kind, q);
    const addActions = node("div", "toolbar");
    for (const [kind, label] of [
      ["choice", "添加单选题"], ["multiple", "添加多选题"],
      ["exact", "添加填空题"], ["length", "添加开放填写题"]
    ]) {
      const add = button(label, "nes-btn");
      add.addEventListener("click", () => questionCard(questions, kind));
      addActions.append(add);
    }
    form.append(addActions, questions);
    const save = button("保存轮次", "nes-btn is-primary");
    save.addEventListener("click", () => {
      save.disabled = true;
      const body = {
        expectedVersion: version,
        position: entry?.position ?? snapshot.rounds.length + 1,
        title: name.value, durationMs: Math.round(Number(duration.value) * 60_000),
        questions: readQuestions(questions),
        ...(entry ? { roundId: entry.id } : {})
      };
      void perform({ type: "round", body },
        (result) => `已保存 · 版本 ${result.version}`, "rounds")
        .finally(() => { save.disabled = false; });
    });
    form.append(save);
    sections.rounds.append(form);
  };
  snapshot.rounds.forEach((round, index) => {
    const row = node("div", "round-row");
    row.append(node("strong", "", `第 ${round.position} 轮 · ${round.title}`),
      node("small", "", `${round.questions.length} 题 · ${round.durationMs / 60_000} 分钟`));
    if (editable) {
      const edit = button(`编辑第 ${round.position} 轮`, "nes-btn");
      edit.addEventListener("click", () => showRoundForm(round));
      row.append(edit);
      if (index > 0) {
        const up = button(`上移第 ${round.position} 轮`, "nes-btn");
        up.addEventListener("click", () => {
          const ids = snapshot.rounds.map((item) => item.id);
          [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
          void perform({ type: "reorder", body: { expectedVersion: version, roundIds: ids } },
            (result) => `已保存 · 版本 ${result.version}`, "rounds");
        });
        row.append(up);
      }
      const remove = button(`删除第 ${round.position} 轮`, "nes-btn is-error");
      remove.addEventListener("click", () => {
        void perform({ type: "delete", roundId: round.id, expectedVersion: version },
          (result) => `已保存 · 版本 ${result.version}`, "rounds");
      });
      row.append(remove);
    }
    roundList.append(row);
  });
  if (editable) {
    const addRound = button("添加轮次", "nes-btn is-primary");
    addRound.addEventListener("click", () => showRoundForm());
    sections.rounds.append(addRound);
  }

  sections.preview.append(node("h2", "pixel-subtitle", "玩家视角预览"));
  const preview = node("div", "preview-grid");
  preview.dataset.preview = "1";
  preview.hidden = true;
  const reveal = button("以玩家身份预览", "nes-btn");
  reveal.addEventListener("click", () => {
    preview.replaceChildren();
    for (const round of snapshot.rounds) {
      const card = node("article", "preview-round");
      card.append(node("h3", "pixel-subtitle", round.title));
      for (const question of round.questions) {
        card.append(node("p", "readable", question.prompt));
        for (const option of question.options ?? []) {
          card.append(node("small", "preview-option", option));
        }
      }
      preview.append(card);
    }
    if (!snapshot.rounds.length) preview.append(node("p", "readable", "先添加轮次"));
    preview.hidden = false;
  });
  sections.preview.append(reveal, preview);
  if (editable) {
    const publish = button("发布游戏", "nes-btn is-success");
    publish.addEventListener("click", () => {
      publish.disabled = true;
      void perform({ type: "publish" }, () => "已发布", "preview")
        .finally(() => { publish.disabled = false; });
    });
    sections.preview.append(publish);
  } else if (snapshot.game.status === "published") {
    const join = field(sections.preview, "加入链接");
    join.value = `${location.origin}/g/${snapshot.game.slug}`;
    join.readOnly = true;
  }

  sections.control.append(node("h2", "pixel-subtitle", "现场控制台"));
  if (snapshot.game.status !== "published") {
    sections.control.append(node("p", "readable", "发布游戏后可以手动开启轮次。"));
  } else {
    for (const round of snapshot.rounds) {
      const card = node("article", "round-row");
      card.append(node("strong", "", round.title),
        node("span", "round-state", round.status === "open" ? "作答中"
          : round.status === "published" ? "已公布" : "待开启"));
      if (round.status === "prepared") {
        const start = button(`开始第 ${round.position} 轮`, "nes-btn is-primary");
        start.addEventListener("click", () => {
          start.disabled = true;
          void perform({ type: "start", roundId: round.id },
            () => "作答中", "control").finally(() => { start.disabled = false; });
        });
        card.append(start);
      }
      sections.control.append(card);
    }
    if (owner) {
      const invite = node("div", "control-form");
      const login = field(invite, "操作员登录名");
      const add = button("邀请操作员", "nes-btn");
      add.addEventListener("click", () => void perform({
        type: "invite", login: login.value
      }, () => "操作员已授权", "control"));
      invite.append(add);
      const select = field(invite, "作废题目", "select", "nes-select");
      select.append(new Option("选择已公布题目", ""));
      for (const round of snapshot.rounds.filter((item) => item.status === "published")) {
        for (const question of round.questions) {
          select.append(new Option(`${round.title} · ${question.prompt}`, question.id));
        }
      }
      const reason = field(invite, "作废原因", "textarea", "nes-textarea");
      const voidButton = button("确认作废", "nes-btn is-error");
      voidButton.addEventListener("click", () => void perform({
        type: "void", questionId: select.value, reason: reason.value
      }, () => "题目已作废，全场重新计分", "control"));
      invite.append(voidButton);
      sections.control.append(invite);
    }
  }
  activate(step);
}
