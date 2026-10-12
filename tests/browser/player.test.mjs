import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveDetails } from "../../src/platform/games/editor.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { startRound, settleDueRounds } from "../../src/platform/quiz/repository.mjs";
import { issueRecovery } from "../../src/platform/players/recovery.mjs";
import { withBrowserFixture } from "./helpers.mjs";

async function publishedGame(pool, four = true) {
  const owner = await createOrganizer(pool, {
    login: "owner", password: "owner-password-1"
  });
  const game = await createGame(pool, owner.id, {
    slug: four ? "four-player-game" : "short-player-game", title: "中文问答之夜"
  });
  const detail = await saveDetails(pool, game.id, owner.id, {
    expectedVersion: 1, title: "中文问答之夜", description: "听完分享再作答",
    fields: [{ key: "team", label: "队伍", type: "select", required: true,
      options: ["甲队", "乙队"] }], leaderboard: true
  });
  const questions = four ? [
    { position: 1, kind: "choice", prompt: "单选问题", points: 7,
      options: ["错", "对"], answerRule: { correctOption: 1 } },
    { position: 2, kind: "multiple", prompt: "多选问题", points: 10,
      options: ["甲", "乙", "丙"], answerRule: { correctOptions: [0, 2] } },
    { position: 3, kind: "exact", prompt: "填空问题", points: 5,
      answerRule: { accepted: ["ＡBC"] } },
    { position: 4, kind: "length", prompt: "表达想法", points: 10,
      answerRule: { minLength: 5, maxLength: 120 } }
  ] : [
    { position: 1, kind: "choice", prompt: "单选问题", points: 7,
      options: ["错", "对"], answerRule: { correctOption: 1 } }
  ];
  const round = await saveRound(pool, game.id, owner.id, {
    expectedVersion: detail.version, position: 1, title: "第一轮",
    durationMs: 30_000, questions
  });
  await publishFrozen(pool, game.id, owner.id);
  return { game, round, owner };
}

async function join(page, base, slug, displayName = "中文玩家") {
  page.setDefaultTimeout(4000);
  await page.goto(`${base}/g/${slug}`);
  await page.getByLabel("展示名").fill(displayName);
  await page.getByLabel("密码").fill("player-password-1");
  await page.getByLabel("队伍").selectOption("甲队");
  await page.getByRole("button", { name: "加入游戏" }).click();
  await page.getByText(/登录码/).waitFor();
}

test("player completes four types, restores a draft and sees only a confirmed published score", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    const { game, round, owner } = await publishedGame(pool);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await join(page, base, game.slug);
    await startRound(pool, game.id, round.id, owner.id, Date.now());
    await page.getByRole("button", { name: "进入第 1 轮" }).click();
    await page.getByRole("radio", { name: "对" }).check();
    await page.getByRole("checkbox", { name: "甲" }).check();
    await page.getByRole("checkbox", { name: "丙" }).check();
    await page.getByLabel("填空问题").fill(" abc ");
    await page.getByLabel("表达想法").fill("我喜欢一起探索");
    await page.reload();
    await page.getByRole("button", { name: "进入第 1 轮" }).click();
    assert.equal(await page.getByRole("radio", { name: "对" }).isChecked(), true);
    assert.equal(await page.getByRole("checkbox", { name: "丙" }).isChecked(), true);
    assert.equal(await page.getByLabel("表达想法").inputValue(), "我喜欢一起探索");
    await page.getByRole("button", { name: "提交答卷" }).click();
    await page.getByText(/提交成功.*回执/).waitFor();
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n, 1);
    await settleDueRounds(pool, Date.now() + 30_001);
    await page.getByText("本轮得分 32").waitFor({ timeout: 10_000 });
    const board = await (await fetch(`${base}/v2/games/${game.slug}/standings`)).json();
    assert.equal(board.players[0].displayName, "中文玩家");
    assert.equal(JSON.stringify(board).includes("甲队"), false);
    await page.close();
  });
});

test("a lost response retries the same persisted key; editing produces a new revision", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    const { game, round, owner } = await publishedGame(pool, false);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await join(page, base, game.slug);
    await startRound(pool, game.id, round.id, owner.id, Date.now());
    await page.getByRole("button", { name: "进入第 1 轮" }).click();
    await page.getByRole("radio", { name: "对" }).check();
    const keys = [];
    let dropped = false;
    await page.route("**/submit", async (route) => {
      keys.push(JSON.parse(route.request().postData()).requestKey);
      const response = await route.fetch();
      if (!dropped) {
        dropped = true;
        await route.abort();
      } else {
        await route.fulfill({ response });
      }
    });
    await page.getByRole("button", { name: "提交答卷" }).click();
    await page.getByText("未确认，可重试原提交").waitFor();
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n, 1);
    await page.getByRole("button", { name: "提交答卷" }).click();
    await page.getByText(/提交成功.*回执/).waitFor();
    assert.equal(keys[0], keys[1]);
    await page.getByRole("radio", { name: "错" }).check();
    await page.getByRole("button", { name: "提交答卷" }).click();
    await page.getByText(/提交成功.*回执/).waitFor();
    assert.notEqual(keys[2], keys[1]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n, 2);
    await page.getByRole("button", { name: "退出账号" }).click();
    await page.getByLabel("展示名").fill("第二位");
    await page.getByLabel("密码").fill("player-password-2");
    await page.getByLabel("队伍").selectOption("乙队");
    await page.getByRole("button", { name: "加入游戏" }).click();
    await page.getByRole("button", { name: "进入第 1 轮" }).click();
    assert.equal(await page.getByRole("radio", { name: "对" }).isChecked(), false);
    assert.equal(await page.getByRole("radio", { name: "错" }).isChecked(), false);
    await page.close();
  });
});

test("one-time recovery, blocked font, Chinese composition and reduced motion remain usable on 320px", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    const { game, round, owner } = await publishedGame(pool);
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    await page.route("**/*.woff2", (route) => route.abort());
    await page.emulateMedia({ reducedMotion: "reduce" });
    await join(page, base, game.slug, "待恢复");
    const player = (await pool.query("SELECT id FROM players WHERE game_id=$1",
      [game.id])).rows[0];
    const code = await issueRecovery(pool, game.id, player.id, owner.id, Date.now());
    await page.getByRole("button", { name: "退出账号" }).click();
    await page.getByRole("button", { name: "我有恢复码" }).click();
    await page.getByLabel("恢复码").fill(code);
    await page.getByLabel("新密码").fill("new-player-password-1");
    await page.getByRole("button", { name: "恢复原账号" }).click();
    await page.getByText("待恢复", { exact: true }).waitFor();
    await startRound(pool, game.id, round.id, owner.id, Date.now());
    await page.getByRole("button", { name: "进入第 1 轮" }).click();
    const input = page.getByLabel("表达想法");
    await input.dispatchEvent("compositionstart");
    await input.fill("正在输入中文");
    await input.dispatchEvent("compositionend");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions")).rows[0].n, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.getByRole("button", { name: "提交答卷" }).isVisible(), true);
    await page.close();
  });
});

test("a device clock two minutes fast still shows the server's live deadline", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    const { game, round, owner } = await publishedGame(pool, false);
    const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
    await page.addInitScript(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 120_000;
    });
    await join(page, base, game.slug);
    await startRound(pool, game.id, round.id, owner.id, Date.now());
    await page.getByRole("button", { name: "进入第 1 轮" }).click();
    await page.getByRole("button", { name: "提交答卷" }).waitFor();
    const timer = await page.locator("#round-timer").textContent();
    const seconds = Number(timer.split(":")[1]);
    assert.equal(timer.startsWith("00:"), true);
    assert.ok(seconds >= 15 && seconds <= 30, timer);
    assert.equal(await page.getByRole("button", { name: "提交答卷" }).isEnabled(), true);
    await page.close();
  });
});
