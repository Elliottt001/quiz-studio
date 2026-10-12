# 通用问答平台：第一阶段本机运行手册

当前 `/v2` 已提供通用中文网页：组织者可从空白创建、配置四种题型、预览发布及手动开轮；玩家通过专属链接报名、作答、领取交卷回执和查看结果。**抽奖、大屏和万人并发验收尚未完成，不要把现有域名切到此服务，也不要把本机演示地址作为已上线入口发给参会群。**旧应用仍由 `npm start` 单独运行。

## 本机 PostgreSQL

要求 Node.js 24.x（至少 24.19.0）及 PostgreSQL 17。macOS/Homebrew 示例：

```sh
brew install postgresql@17
brew services start postgresql@17
/opt/homebrew/opt/postgresql@17/bin/createdb quiz_platform
/opt/homebrew/opt/postgresql@17/bin/createdb quiz_platform_test
npm ci
```

创建被 Git 忽略的 `.env.platform`，填写**实际**的本机用户名和数据库地址，不把管理员密码写入文件：

```text
DATABASE_URL=postgresql://bytedance@localhost/quiz_platform
HOST=127.0.0.1
PORT=4183
```

先执行 `npm run migrate:platform`、`npm run build:platform`，再在交互终端执行 `npm run bootstrap:platform -- owner`；口令至少 16 字符，由终端隐藏读取，初始化成功后用平台账号创建其他组织者。执行 `npm run start:platform`，用 `curl -fsS http://127.0.0.1:4183/v2/health` 检查数据库连通，然后打开 `http://127.0.0.1:4183/organizer` 创建游戏；首页为 `http://127.0.0.1:4183/`，玩家链接由组织者发布后在控制台取得，格式为 `/g/游戏标识`。平台起初**没有任何默认游戏或题目**。没运行 `build:platform` 时服务拒绝启动，不会给玩家一个缺资源的页面。

联排先使用独立测试游戏，在组织者页面完成“基本信息 → 报名字段 → 轮次题目 → 预览发布”。发布即冻结题目、标准答案、时长和报名字段；只有本场 owner/operator 可手动开启轮次。玩家页须实际显示提交回执编号才算交卷；草稿保存、按钮点击或浏览器超时都不等于成功。要验证整站而不只是健康端点，请在**已有已发布测试游戏**后运行：

```sh
npm run verify:platform -- http://127.0.0.1:4183 quiz-night
```

把 `quiz-night` 换为刚发布游戏的真实标识。脚本会检查健康、首页、组织者页、该场玩家页和公开轮次状态；尚无已发布游戏时它应失败。

只有在 HTTPS 反向代理或隧道已就绪、访问来源已受控时，才填写 `PUBLIC_ORIGIN=https://实际使用的域名`。保持 `HOST=127.0.0.1`，让代理连接本机端口，不要直接公开明文端口或 PostgreSQL 5432。若部署环境确实要求在非回环地址监听，还须设置 `TRUSTED_HTTPS_PROXY=1` 并先用防火墙阻断直连 HTTP；这些配置项本身不能证明代理可信。公网请求必须带准确 HTTPS Origin，Cookie 使用 Secure、HttpOnly、SameSite=Strict。**免费隧道能否承接一万人同时在线以及一秒突发，未经实测不作保证。**

## 测试与备份

在隔离测试库执行：

```sh
TEST_DATABASE_URL=postgresql://bytedance@localhost/quiz_platform_test npm run test:platform
npm test
npm run check
npm run build
npm run build:platform
npx playwright install chromium
TEST_DATABASE_URL=postgresql://bytedance@localhost/quiz_platform_test npm run test:browser
```

`test:platform` 和 `test:browser` 都需要 `TEST_DATABASE_URL`；未设置或连接到的数据库不叫 `quiz_platform_test` 时必须失败。测试创建自己的随机 schema，不会向运行库导入旧活动数据。旧 `npm test` 保留旧程序与归档工具测试。不要把正式数据库地址传入 `TEST_DATABASE_URL`。平台的 NES.css 2.3.0（MIT）和 Fusion Pixel Font 2026.09.25（OFL-1.1）均随静态资源自托管并保留许可文件；中文标题等短文案用像素字体，长题干和输入使用常规中文字体。

旧 SQLite 数据只单独存档，不导入新平台。在旧仓库和新 worktree 并存时，应提供旧仓库的**绝对来源路径**：

```sh
node scripts/archive-legacy.mjs \
  /Users/bytedance/Projects/xlab-annual-quiz/data/game.sqlite \
  "$HOME/Documents/quiz-legacy-archive-2026-10-12"
```

存档脚本使用 SQLite 在线备份处理 WAL，创建权限受限的快照与带 SHA-256 的清单，不覆盖已有存档，也不删除源文件。将清单与受保护的离机介质分别保存，并对存档执行 `node scripts/backup-check.mjs "$HOME/Documents/quiz-legacy-archive-2026-10-12/legacy.sqlite"`。存档包含真名和答卷，不得上传到公开 GitHub 仓库。

新 PostgreSQL 数据库的定期备份与恢复示例；归档文件也必须转存到独立介质：

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_dump -Fc -f "$HOME/Documents/quiz-platform.dump" quiz_platform
/opt/homebrew/opt/postgresql@17/bin/createdb quiz_platform_restore
/opt/homebrew/opt/postgresql@17/bin/pg_restore -d quiz_platform_restore "$HOME/Documents/quiz-platform.dump"
```

恢复演练只针对新建的 `quiz_platform_restore`，不要在正在运行的库上覆盖。当前单进程的截止前在途请求协调不支持多 Node 工作进程；第四阶段建立跨进程屏障并完成真实公网链路 5 场 × 2,000 人、一秒 10,000 交卷且 5 秒内收到持久化回执的验收前，不得宣传或依赖此容量。

## 分期边界

- 第二阶段（当前）：组织者填写入口、四类题型、自定义报名字段、版本管理、玩家页面和基础中文像素组件。
- 第三阶段：可选积分抽奖、像素风大屏与颁奖体验、视觉细化，以及清理旧活动专属页面和素材。
- 第四阶段：跨进程入库/结算协调、实时状态推送、实际入口分布式压测、离机备份与灾难恢复。
