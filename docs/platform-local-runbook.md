# 通用问答平台：第一阶段本机运行手册

当前 `/v2` 仅提供组织者、游戏、玩家、单选题轮次及交卷 API。**尚无通用填写界面、抽奖和万人并发验收，不要把现有域名切到此服务，也不要将其发给普通玩家。**旧应用仍由 `npm start` 单独运行。

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

先执行 `npm run migrate:platform`，再在交互终端执行 `npm run bootstrap:platform -- owner`；口令至少 16 字符，由终端隐藏读取，初始化成功后用平台账号创建其他组织者。执行 `npm run start:platform`，用 `curl -fsS http://127.0.0.1:4183/v2/health` 检查数据库连通。平台起初**没有任何默认游戏或题目**。组织者通过 `/v2/auth/login` 和 `/v2/games` 等 JSON API 操作；可视化配置入口属于第二阶段，不得把这个 API 当作已经完成的玩家应用。

只有在 HTTPS 反向代理或隧道已就绪、访问来源已受控时，才填写 `PUBLIC_ORIGIN=https://实际使用的域名`。保持 `HOST=127.0.0.1`，让代理连接本机端口，不要直接公开明文端口或 PostgreSQL 5432。若部署环境确实要求在非回环地址监听，还须设置 `TRUSTED_HTTPS_PROXY=1` 并先用防火墙阻断直连 HTTP；这些配置项本身不能证明代理可信。公网请求必须带准确 HTTPS Origin，Cookie 使用 Secure、HttpOnly、SameSite=Strict。**免费隧道能否承接一万人同时在线以及一秒突发，未经实测不作保证。**

## 测试与备份

在隔离测试库执行：

```sh
TEST_DATABASE_URL=postgresql://bytedance@localhost/quiz_platform_test npm run test:platform
npm test
npm run check
npm run build
```

`test:platform` 未设置 `TEST_DATABASE_URL` 或连接到的数据库不叫 `quiz_platform_test` 时必须失败；测试创建自己的随机 schema，不会向运行库导入旧活动数据。旧 `npm test` 保留旧程序与归档工具测试。不要把正式数据库地址传入 `TEST_DATABASE_URL`。

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

- 第二阶段：组织者可视化填写入口、四类题型、自定义报名字段、版本管理和玩家页面。
- 第三阶段：可选积分抽奖、NES.css 像素组件、Fusion Pixel 中文字体、响应式大屏，以及清理旧活动专属页面和素材。
- 第四阶段：跨进程入库/结算协调、实时状态推送、实际入口分布式压测、离机备份与灾难恢复。
