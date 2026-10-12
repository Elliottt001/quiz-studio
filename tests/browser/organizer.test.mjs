import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrganizer } from "../../src/platform/organizers/repository.mjs";
import { createGame } from "../../src/platform/games/repository.mjs";
import { saveRound, publishFrozen } from "../../src/platform/quiz/editor.mjs";
import { withBrowserFixture } from "./helpers.mjs";

async function login(page, base, name, password) {
  page.setDefaultTimeout(3000);
  await page.goto(base + "/organizer");
  await page.getByLabel("组织者账号").fill(name);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "创建游戏" }).waitFor();
}

test("organizer builds four question types, previews and publishes from an empty wizard", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await login(page, base, "owner", "owner-password-1");
    await page.getByRole("button", { name: "创建游戏" }).click();
    await page.getByLabel("游戏标识").fill("science-night");
    await page.getByLabel("游戏名称").fill("科学之夜");
    await page.getByRole("button", { name: "创建空白游戏" }).click();
    await page.getByLabel("游戏介绍").fill("从分享里寻找线索");
    await page.getByRole("button", { name: "报名字段" }).click();
    await page.getByRole("button", { name: "添加报名字段" }).click();
    await page.getByLabel("字段键").fill("team");
    await page.getByLabel("字段名称").fill("队伍");
    await page.getByLabel("字段类型").selectOption("select");
    await page.getByLabel("选项（每行一个）").fill("甲队\n乙队");
    await page.getByRole("button", { name: "保存草稿" }).click();
    await page.getByText("已保存 · 版本 2").waitFor();
    await page.getByRole("button", { name: "轮次题目" }).click();
    await page.getByRole("button", { name: "添加轮次" }).click();
    await page.getByLabel("轮次标题").fill("挑战一");
    await page.getByLabel("作答时长（分钟）").fill("1");
    for (const [kind, label, prompt] of [
      ["choice", "添加单选题", "单选问题"],
      ["multiple", "添加多选题", "多选问题"],
      ["exact", "添加填空题", "填空问题"],
      ["length", "添加开放填写题", "表达想法"]
    ]) {
      await page.getByRole("button", { name: label }).click();
      await page.locator(`[data-question-kind="${kind}"]`).getByLabel("题干").fill(prompt);
    }
    const choice = page.locator('[data-question-kind="choice"]');
    await choice.getByLabel("选项（每行一个）").fill("A\nB");
    await choice.getByLabel("正确选项序号").fill("2");
    const multiple = page.locator('[data-question-kind="multiple"]');
    await multiple.getByLabel("选项（每行一个）").fill("甲\n乙\n丙");
    await multiple.getByLabel("正确选项序号（逗号分隔）").fill("1,3");
    await page.locator('[data-question-kind="exact"]')
      .getByLabel("可接受答案（每行一个）").fill("Ada\nＡＢＣ");
    const length = page.locator('[data-question-kind="length"]');
    await length.getByLabel("最少字数").fill("5");
    await length.getByLabel("最多字数").fill("120");
    await page.getByRole("button", { name: "保存轮次" }).click();
    await page.getByText("已保存 · 版本 3").waitFor();
    await page.reload();
    await page.getByText("挑战一", { exact: true }).waitFor();
    await page.getByRole("button", { name: "预览发布" }).click();
    await page.getByRole("button", { name: "以玩家身份预览" }).click();
    await page.locator("[data-preview]").getByText("表达想法").waitFor();
    await page.getByRole("button", { name: "发布游戏" }).click();
    await page.getByText("已发布", { exact: true }).waitFor();
    const url = await page.getByLabel("加入链接").inputValue();
    assert.match(url, /\/g\/science-night$/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM questions")).rows[0].n, 4);
    assert.equal((await pool.query("SELECT status FROM games")).rows[0].status, "published");
    await page.close();
  });
});

test("stale organizer tab retains input; operator controls a published game without editing it", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    const owner = await createOrganizer(pool, {
      login: "owner", password: "owner-password-1"
    });
    const operator = await createOrganizer(pool, {
      login: "operator", password: "operator-password-1"
    });
    const game = await createGame(pool, owner.id, { slug: "shared-game", title: "原名称" });
    await saveRound(pool, game.id, owner.id, {
      expectedVersion: 1, position: 1, title: "第一轮",
      durationMs: 30_000, questions: [{ position: 1, kind: "choice", prompt: "Ready?",
        options: ["No", "Yes"], answerRule: { correctOption: 1 }, points: 7 }]
    });
    await pool.query("INSERT INTO game_members(game_id,organizer_id,role) VALUES($1,$2,'operator')",
      [game.id, operator.id]);
    const first = await browser.newPage();
    const stale = await browser.newPage();
    await login(first, base, "owner", "owner-password-1");
    await login(stale, base, "owner", "owner-password-1");
    await first.goto(base + `/organizer?game=${game.id}`);
    await stale.goto(base + `/organizer?game=${game.id}`);
    await first.getByLabel("游戏名称").fill("新名称");
    await first.getByRole("button", { name: "保存草稿" }).click();
    await first.getByText("已保存 · 版本 3").waitFor();
    await stale.getByLabel("游戏名称").fill("旧标签页输入");
    await stale.getByRole("button", { name: "保存草稿" }).click();
    await stale.getByText("版本冲突，当前输入仍保留").waitFor();
    assert.equal(await stale.getByLabel("游戏名称").inputValue(), "旧标签页输入");
    await publishFrozen(pool, game.id, owner.id);
    const op = await browser.newPage();
    await login(op, base, "operator", "operator-password-1");
    await op.goto(base + `/organizer?game=${game.id}`);
    await op.locator(".round-chip").getByText("第一轮", { exact: true }).waitFor();
    assert.equal(await op.getByRole("button", { name: "保存草稿" }).count(), 0);
    await op.getByRole("button", { name: "控制台" }).click();
    await op.getByRole("button", { name: "开始第 1 轮" }).click();
    await op.locator(".round-state").getByText("作答中").waitFor();
    await first.close();
    await stale.close();
    await op.close();
  });
});

test("organizer can reorder, delete and revise draft rounds from the page", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    const owner = await createOrganizer(pool, {
      login: "owner", password: "owner-password-1"
    });
    const game = await createGame(pool, owner.id, { slug: "order-game", title: "Order" });
    for (let position = 1; position <= 3; position++) {
      await saveRound(pool, game.id, owner.id, {
        expectedVersion: position, position,
        title: `第${position}轮`, durationMs: 30_000,
        questions: [{ position: 1, kind: "choice", prompt: `题目${position}`,
          options: ["No", "Yes"], answerRule: { correctOption: 1 }, points: 7 }]
      });
    }
    const page = await browser.newPage();
    await login(page, base, "owner", "owner-password-1");
    await page.goto(base + `/organizer?game=${game.id}`);
    await page.getByRole("button", { name: "轮次题目" }).click();
    await page.getByRole("button", { name: "上移第 3 轮" }).click();
    await page.getByText("已保存 · 版本 5").waitFor();
    await page.getByRole("button", { name: "删除第 2 轮" }).click();
    await page.getByText("已保存 · 版本 6").waitFor();
    await page.getByRole("button", { name: "编辑第 1 轮" }).click();
    await page.getByLabel("轮次标题").fill("已修改");
    await page.getByRole("button", { name: "保存轮次" }).click();
    await page.getByText("已保存 · 版本 7").waitFor();
    assert.deepEqual((await pool.query(`SELECT position,title FROM rounds
      WHERE game_id=$1 ORDER BY position`, [game.id])).rows.map((row) => row.position), [1, 2]);
    assert.equal((await pool.query(`SELECT title FROM rounds
      WHERE game_id=$1 AND position=1`, [game.id])).rows[0].title, "已修改");
    await page.close();
  });
});

test("the organizer wizard has accessible controls without horizontal overflow", async () => {
  await withBrowserFixture(async ({ pool, browser, base }) => {
    await createOrganizer(pool, { login: "owner", password: "owner-password-1" });
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await login(page, base, "owner", "owner-password-1");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.getByRole("button", { name: "创建游戏" }).isVisible(), true);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });
});
