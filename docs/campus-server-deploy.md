# 校网服务器部署：HTTP IP 直连完整游戏

适用于会场所有设备连同一校网、能访问一台 Linux 服务器的情形。GitHub 只保存代码；Node 服务和 SQLite 数据库在服务器上持续运行。微信群发送 `http://服务器内网IP:4173/`，所有手机、个人电脑、公用电脑都打开同一个玩家入口。管理员用 `http://服务器内网IP:4173/admin.html`，大屏用 `http://服务器内网IP:4173/display.html`。不需要 Nginx、DNS、HTTPS 证书或 GitHub Pages 代理。

## 必须先确认

- 服务器有固定的私有 IPv4 地址（如 `10.x.x.x`、`172.16–31.x.x` 或 `192.168.x.x`）；会场校网/Wi-Fi 的约 200 台设备能够访问服务器的 TCP 4173，且无线客户端未被隔离。**不要把 `127.0.0.1` 发给参会者**：那代表各人自己的设备。
- 服务器所在网段**不可从公网访问**；由校网管理员在边界防火墙及服务器防火墙上只允许会场校网来源访问 TCP 4173。`HOST=0.0.0.0` 会监听服务器所有网卡，**配置文件本身不能代替防火墙**。
- HTTP 明文传输注册资料、玩家密码、管理员口令及会话 Cookie；共享或不可信的校网用户可能截获或篡改流量。不要复用任何私人密码；管理员只在受控电脑登录，操作后退出。若校网无法隔离非参会者或有更高保密需求，应使用 HTTPS，而非此方案。
- 部分手机/微信内浏览器可能对 HTTP 链接弹出风险提示或限制打开；用现场实际手机和微信提前测试，必要时改用系统浏览器。保持使用 `http://`，不能写成 `https://`。

## 安装并设置开机常驻

在服务器安装 Node.js **24.19.0+ 的 24.x**、Git，确认 `node --version` 和 `command -v node`。下面的 systemd 文件默认 Node 位于 `/usr/bin/node`；路径不同要改 `ExecStart`。以下命令在服务器上运行，按发行版调整用户创建命令：

```bash
sudo useradd --system --home-dir /opt/xlab-annual-quiz --shell /usr/sbin/nologin xlab-game
sudo mkdir -p /var/lib/xlab-annual-quiz /etc/xlab-annual-quiz
sudo chown xlab-game:xlab-game /var/lib/xlab-annual-quiz
sudo chmod 700 /var/lib/xlab-annual-quiz
sudo git clone https://github.com/Elliottt001/xlab-annual-quiz.git /opt/xlab-annual-quiz
cd /opt/xlab-annual-quiz
npm test
npm run check
npm run build
sudo cp deploy/campus/game.env.example /etc/xlab-annual-quiz/game.env
sudo cp deploy/campus/xlab-annual-quiz.service /etc/systemd/system/
```

运行 `node scripts/admin-password.mjs`，在服务器终端输入至少 6 字符的**单独管理员口令**，将输出的哈希替换 `/etc/xlab-annual-quiz/game.env` 中的占位符。环境文件保持 `CAMPUS_HTTP_ONLY=1`、`HOST=0.0.0.0`、`PORT=4173`、绝对路径 `DATA_DIR=/var/lib/xlab-annual-quiz`；不要同时设置 `PUBLIC_ORIGIN`、`TRUSTED_HTTPS_PROXY`、`CAMPUS_PROXY_ONLY` 或 TLS 路径。不要把明文口令发群、写进 Git 或 shell 历史。然后：

```bash
sudo chmod 600 /etc/xlab-annual-quiz/game.env
sudo chown -R xlab-game:xlab-game /opt/xlab-annual-quiz
sudo systemctl daemon-reload
sudo systemctl enable --now xlab-annual-quiz
sudo systemctl status xlab-annual-quiz
curl -fsS http://127.0.0.1:4173/api/health
```

若服务启动失败，查看 `sudo journalctl -u xlab-annual-quiz -n 100 --no-pager`；优先检查 Node 路径、构建产物、管理员哈希、文件权限和端口占用。按学校防火墙流程仅向会场校网开放 TCP 4173，不要无范围地运行“向所有人开放端口”的命令。

## 验收后发群

把示例 `10.12.34.56` 全部换成服务器**实际固定内网 IP**：

```bash
curl -fsS http://10.12.34.56:4173/api/health
cd /opt/xlab-annual-quiz
npm run verify:campus -- http://10.12.34.56:4173
```

自检要同时得到 `health/player/admin/display: true`。还必须从会场校网的**两部真实手机**（包括微信群里点链接）和一台电脑访问同一 IP，验证注册、退出、换机登录、管理员开轮、5 分钟自动收卷、排名与抽奖；关闭移动数据测试校网路径。用独立演练数据库测四轮完整流程，勿把测试题目和奖品带入正式库；正式库须导入审核后的 30 题及真实奖品。重启 `sudo systemctl restart xlab-annual-quiz` 后确认账号和分数仍在，验收约 200 人并发及最后一秒集中交卷。

`systemctl enable --now` 实现开机自启，`Restart=always` 在异常退出后重启；断电、网络故障或磁盘损坏不在此保证之内。运行日志用 `sudo journalctl -u xlab-annual-quiz -f` 查看。定期把 `backup-latest.sqlite` 的有效快照复制到独立介质，并演练恢复。会后限制访问或停服务，按活动方的数据保留要求清理真名、登录资料和答题记录。

原 `https://x-lab.game.elliotttzhang.cn/` 的 GitHub Pages 仍只是说明页，**不会自动转发到内网服务器**。推送仓库也不会自动更新已运行服务；更新前备份数据库，在服务器拉取代码、重新构建并重启服务。仓库保留了 HTTPS 代理模板，日后有证书时可另外切换，不能同时混用两种模式。
