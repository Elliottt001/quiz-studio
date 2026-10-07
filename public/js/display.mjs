import { api, remainingLabel } from "./api.mjs";

const $ = (id) => document.getElementById(id);
let offset = 0;
let deadline = null;
let lastDraw = null;

function stageBoard(players) {
  const board = $("stage-board");
  board.replaceChildren();
  for (const entry of players.slice(0, 3)) {
    const card = document.createElement("div");
    card.className = "mini-player";
    const name = document.createElement("strong");
    name.textContent = entry.nickname;
    const detail = document.createElement("small");
    detail.textContent = entry.realName;
    const score = document.createElement("em");
    score.textContent = `${entry.score} PTS`;
    card.append(name, detail, score);
    board.append(card);
  }
  board.hidden = !players.length;
}

function ticker() {
  if (deadline === null) return;
  const left = deadline - (Date.now() + offset);
  $("stage-timer").textContent = remainingLabel(left);
  $("stage-timer").classList.toggle("urgent", left <= 30_000);
}

async function update() {
  try {
    const [state, board, poolData, prizesData, drawsData] = await Promise.all([
      api("/api/state"), api("/api/standings"), api("/api/pool"), api("/api/prizes"), api("/api/draws")
    ]);
    offset = state.serverTime - Date.now();
    $("stage-players").textContent = `${state.registeredCount} 位玩家已加入`;
    const live = state.rounds.find((round) => round.status === "open");
    const latest = drawsData.draws.at(-1);
    if (latest && poolData.pool) {
      deadline = null;
      $("stage-timer").hidden = true;
      $("stage-board").hidden = true;
      $("stage-winner").hidden = false;
      const prize = prizesData.prizes.find((p) => p.id === latest.prizeId);
      const person = poolData.pool.entries.find((p) => p.playerId === latest.playerId);
      $("stage-kicker").textContent = "PLAY THE INFINITE / LUCKY MOMENT";
      $("stage-title").textContent = "惊喜时刻";
      $("stage-subtitle").textContent = `奖池 ${poolData.pool.entries.length} 人 · ${
        poolData.pool.entries.reduce((sum, item) => sum + item.balls, 0)
      } 颗初始小球 · 每颗球机会相同`;
      $("winner-prize").textContent = prize?.title ?? latest.prizeId;
      $("winner-nickname").textContent = person?.nickname ?? latest.playerId.slice(0, 8);
      $("winner-realname").textContent = person?.realName ?? "";
      $("winner-ball").textContent = `抽中球号 ${latest.selectedBallId.split(":").at(-1)} · 抽取前 ${latest.totalBallsBefore} 颗球`;
      $("stage-status").textContent = latest.status === "refused" ? "此奖已放弃 · 等待公开补抽" : "中奖者请上台核验身份";
      if (lastDraw !== latest.id) {
        $("stage-winner").animate?.([
          { opacity: 0, transform: "translateY(22px)" },
          { opacity: 1, transform: "translateY(0)" }
        ], { duration: 650, easing: "ease-out" });
        lastDraw = latest.id;
      }
    } else if (poolData.pool) {
      deadline = null;
      $("stage-timer").hidden = true;
      $("stage-board").hidden = true;
      $("stage-winner").hidden = true;
      $("stage-kicker").textContent = "PRIZE POOL / LOCKED";
      $("stage-title").textContent = "等待开奖";
      $("stage-subtitle").textContent = `${poolData.pool.entries.length} 位玩家，${
        poolData.pool.entries.reduce((sum, entry) => sum + entry.balls, 0)
      } 颗虚拟小球。先三等奖、再二等奖、最后大奖。`;
      $("stage-status").textContent = "奖池已冻结 · 等待管理员抽取";
    } else if (live) {
      deadline = live.deadlineAt;
      $("stage-timer").hidden = false;
      $("stage-winner").hidden = true;
      $("stage-board").hidden = true;
      $("stage-kicker").textContent = `SIDE QUEST 0${live.id} / 04`;
      $("stage-title").textContent = live.title;
      $("stage-subtitle").textContent = `${[6, 10, 9, 5][live.id - 1]} 道题 · 请在手机确认“提交成功”`;
      $("stage-status").textContent = `${state.submissionCounts[live.id]} 人已交卷`;
      ticker();
    } else {
      deadline = null;
      $("stage-timer").hidden = true;
      $("stage-winner").hidden = true;
      $("stage-kicker").textContent = "READY TO PLAY / 2026";
      $("stage-title").textContent = "无限游戏";
      const completed = state.rounds.filter((round) => round.status === "published").length;
      $("stage-subtitle").textContent = completed
        ? `已经完成 ${completed} / 4 轮。成绩和排名已在手机公布。`
        : "连接会场校网，打开微信群中的游戏链接，加入这场游戏。";
      $("stage-status").textContent = completed ? "等待下一轮手动开启" : "等待管理员开启第一轮";
      stageBoard(completed ? board.players : []);
    }
    $("stage-link").textContent = `${location.origin} · 请先连接会场校网`;
  } catch (error) {
    $("stage-status").textContent = `现场服务暂时不可达 · ${error.message}`;
  }
}

setInterval(ticker, 250);
setInterval(() => void update(), 2000);
void update();
