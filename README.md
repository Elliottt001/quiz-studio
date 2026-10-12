<div align="center">

# Quiz Studio

### 把一场问答活动，从空白配置到现场结算，放进一个链接里。

无需安装 App。组织者在浏览器里编题、发布和开轮，玩家打开专属链接即可报名、作答并领取持久化交卷回执。

[![Platform tests](https://github.com/Elliottt001/xlab-annual-quiz/actions/workflows/platform-tests.yml/badge.svg)](https://github.com/Elliottt001/xlab-annual-quiz/actions/workflows/platform-tests.yml)
![Node.js 24](https://img.shields.io/badge/Node.js-24.19%2B-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)

</div>

---

## 一套真正为现场而生的答题流程

| 组织者 | 玩家 | 现场保障 |
|---|---|---|
| 从空白创建游戏，配置报名字段、轮次和题目 | 一个链接进入，手机浏览器直接参与 | 发布后冻结规则，避免活动中途误改 |
| 支持单选、多选、精确文本和按长度赠分 | 草稿自动保存，刷新后继续作答 | 每次成功提交都有持久化回执编号 |
| 预览、发布、手动开轮、作废错题并重新计分 | 登录态按游戏隔离，不串场 | 操作权限、恢复码和审计记录均有边界 |

界面采用中文像素风，但关键内容保持清晰易读；NES.css 与 Fusion Pixel 字体随服务自托管，不依赖现场网络加载 CDN。

## 核心亮点

- **四种题型**：单选、多选、精确文本、按字符长度赠分。
- **可视化配置**：基本信息 → 报名字段 → 轮次题目 → 预览发布，一条流程完成建场。
- **版本化发布**：草稿可持续编辑，正式发布后冻结题目、答案、时长与报名字段。
- **可靠交卷**：草稿不计分，只有服务端持久化并返回回执才算提交成功。
- **权限隔离**：平台管理员、游戏 owner、operator 和玩家各自拥有明确权限。
- **确定性计分**：规则可测试、错题可作废、排名可重算，不靠人工改数据库。
- **隐私优先**：公开页面不泄露标准答案、私有报名信息或其他玩家的敏感数据。

## 5 分钟本地启动

### 1. 准备环境

- Node.js `24.19.0+`，且保持在 Node 24.x
- PostgreSQL 17

macOS / Homebrew：

```bash
brew install postgresql@17
brew services start postgresql@17
createdb quiz_platform
npm ci
```

### 2. 配置数据库

在项目根目录创建被 Git 忽略的 `.env.platform`：

```text
DATABASE_URL=postgresql://你的本机用户名@localhost/quiz_platform
HOST=127.0.0.1
PORT=4183
```

### 3. 初始化并启动

```bash
npm run migrate:platform
npm run build:platform
npm run bootstrap:platform -- owner
npm run start:platform
```

首次初始化会要求输入两次管理员口令：至少 6 个字符，不能是纯数字，输入过程不会回显。

启动后访问：

- 首页：<http://127.0.0.1:4183/>
- 组织者控制台：<http://127.0.0.1:4183/organizer>
- 健康检查：<http://127.0.0.1:4183/v2/health>

以后再次运行只需：

```bash
npm run start:platform
```

更完整的数据库、验证和代理配置见[平台本地运行手册](docs/platform-local-runbook.md)。

## 从创建到开场

```text
创建游戏 → 配置报名 → 编排轮次与题目 → 预览发布
                                         ↓
查看排名 ← 持久化回执 ← 玩家作答 ← 分享 /g/游戏标识
```

1. 使用平台管理员账号登录组织者控制台并创建游戏。
2. 设置玩家报名字段，添加轮次和题目，确认计分规则。
3. 预览并发布；发布会冻结当前版本。
4. 将生成的 `/g/游戏标识` 链接发给玩家。
5. owner 或 operator 手动开轮，玩家提交后必须看到回执编号。

平台不会预置演示游戏或假题，第一次启动看到空列表是正常行为。

## 开发与验证

```bash
# 静态语法检查
npm run check

# 旧系统与归档测试
npm test

# PostgreSQL 平台测试（必须使用独立测试库）
createdb quiz_platform_test
TEST_DATABASE_URL=postgresql://你的本机用户名@localhost/quiz_platform_test npm run test:platform

# 浏览器端到端测试
npx playwright install chromium
TEST_DATABASE_URL=postgresql://你的本机用户名@localhost/quiz_platform_test npm run test:browser
```

测试会创建随机 schema，不会把夹具写入正式运行库。`TEST_DATABASE_URL` 如果不是名为 `quiz_platform_test` 的数据库，测试会主动拒绝运行。

## 当前边界

新版通用平台目前完成了创建、配置、发布、作答、回执、基础排名和错题重算。以下能力仍在后续阶段：

- 通用抽奖、像素风大屏与颁奖体验
- 跨进程截止屏障与实时状态推送
- 真实公网链路下一秒 10,000 次交卷的容量验收
- 完整灾难恢复与离机备份演练

因此，请不要把本地演示地址当作正式线上入口，也不要在完成真实网络、备份和并发验收前宣传万人并发能力。

---

<div align="center">

**让组织者少救火，让玩家每一次提交都有答案。**

</div>
