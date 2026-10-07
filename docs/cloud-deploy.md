# 将同一公网域名切换为完整答题应用

## 为什么现在不能用 GitHub Pages 直接答题

现有 Pages 是静态说明页，没有运行中的 Node API 或持久化数据库。完整游戏必须持续处理注册、统一截止、判分、实时排行和抽奖。GitHub 继续存代码；`render.yaml` 提供“一个托管 Node 服务＋一块持久化磁盘”的配置模板。托管服务及磁盘是有持续费用的资源，创建前在 Render 界面核对实际账单。

## Render Blueprint 建立完整服务

1. 在 Render 控制台用自己的 GitHub 身份登录，选择 **New → Blueprint**，授权并选择 `Elliottt001/xlab-annual-quiz`，使用根目录 `render.yaml`。它配置 `runtime: node`、`plan: starter`、`/var/data` 持久化数据盘、健康检查 `/api/health`。确认页面上的 Web Service 和 Disk 计费明细后再创建。
2. 用项目自带脚本 `node scripts/admin-password.mjs` 生成管理员密码**哈希**（不要把明文写入仓库）；在 Blueprint 询问 `ADMIN_PASSWORD_HASH` 时填入哈希。后台账号与普通玩家账号分开。Render 提供的暂用地址应为 HTTPS；无需自行上传 TLS 私钥。若 Blueprint 无法自动设置 Node 版本，手动设 `NODE_VERSION=24.19.0`。拿到实际 Render 服务地址后，在服务环境变量中增加 `PREVIEW_ORIGIN=https://实际服务名.onrender.com`，不得填猜测的服务名；这样暂用域名与最终域名都能发起同源表单请求。
3. 确认新服务日志显示建表成功，`/api/health` 返回 200。通过 Render 暂用域名分别打开 `/`、`/admin.html`、`/display.html`。注册测试玩家，记下登录码，退出后在另一台设备登录原账号。用**独立测试服务或空白演练数据库**验证四轮开收题、加分、球池与抽奖，不在未来正式数据库中导入测试题。
4. 验证 Render 控制台重启／重新部署后玩家与分数仍存在。数据库 `DATA_DIR=/var/data`，必须落在持久化磁盘。应用在每轮、冻结和抽奖后写 `backup-latest.sqlite`，但该备份与主库在**同一块盘上**；正式活动前必须准备独立盘外备份与恢复演练。
5. 在 Render 服务 **Settings → Custom Domains → Add Custom Domain** 填 `x-lab.game.elliotttzhang.cn`。从 Render 面板读取它给你的**实际 CNAME 目标**，不要猜。先保留 GitHub Pages 旧 CNAME 和公开说明页，直至 Render 暂用域名的完整游戏通过测试。
6. 在火山引擎 TrafficRoute DNS 套件 → 云解析 DNS → `elliotttzhang.cn` 的**公网记录管理**找到 `x-lab.game`。将其 CNAME 的值从 `Elliottt001.github.io` 改为 Render 面板给出的目标；同名不能并存两个冲突 CNAME。等待解析生效与 Render 为新域名签发 HTTPS 证书。必须从真实手机和电脑打开 `https://x-lab.game.elliotttzhang.cn/`，分别验证注册、登录、管理员、答题、抽奖及 API。
7. 在 HTTPS 完整链路验证通过后，从 GitHub 仓库 `Settings → Pages` 移除旧的自定义域名绑定；停止或改造旧 Pages 工作流，避免未来误将静态说明页当成正式入口。切换期间不要重新把 CNAME 指回 GitHub。

## 安全与共享设备

- 账号唯一登录码在首次注册及个人大厅中显示，密码只在注册、登录和恢复时输入；服务器只保存带盐的密码哈希和会话哈希。相同真名／昵称不自动合并。
- 公用电脑使用普通玩家登录后点击**退出账号**，管理员使用完后台也点击**退出管理员**。不要在公共浏览器保存密码或直接关闭标签页代替退出。
- 正式服务要求 `TRUSTED_HTTPS_PROXY=1`、`PUBLIC_ORIGIN=https://x-lab.game.elliotttzhang.cn`、有效管理员密码哈希。临时预览域名必须通过 `PREVIEW_ORIGIN` 明确配置；不能用任意请求的 Host 自动放行。仅在受控托管服务中启用代理模式；不能将无 TLS 的 Node 端口直接公开到互联网。
- 旧本地数据库里没有玩家密码的账号会原样保留分数，不能按姓名直接登录；需管理员核验后发一次性恢复码，由本人设置新密码。
- 生产环境至少用约 300 个测试连接、200 个最后一秒提交做独立压测；本机回环测试不能证明云服务资源规格适合年会。

## 当前阻塞

仓库现有的 GitHub 登录权限**不等于 Render 账户或付费资源权限**。截至写本文，托管服务尚未在 Render 账户创建，未获得它分配的公网地址／CNAME，因此域名仍指向 GitHub Pages 静态说明页。未完成上述步骤，不得向参会群宣称域名已可答题。
