# 校网服务器部署：用服务器域名提供完整游戏

适用于 **Linux + systemd + Nginx**、参会设备均能访问校网内网服务器的情形。GitHub 只保存程序；唯一的生产 Node 进程和 SQLite 数据库均运行在校网服务器。玩家、管理员与大屏都使用**服务器实际 HTTPS 域名**，分别访问 `/`、`/admin.html`、`/display.html`。普通电脑与公用电脑完全一样，都用个人登录码和密码进入，操作后退出。管理员用独立口令登录后台。

## 前提：网络和证书

向校网管理员确认：服务器有**固定校网 IP**，会场 Wi-Fi 客户端能访问该 IP 的 TCP 443（没有客户端隔离），**服务器域名已在这些设备上解析到这个 IP**。如果服务器域名已有可用的校网解析，直接使用它，不需要动火山引擎、原有公网链接或 GitHub Pages。不要把 `4173` 端口暴露到校网。

Nginx 必须使用手机/微信信任的、**针对所选服务器域名的有效证书**。如果校网服务器域名已有学校提供的有效证书，直接复用；否则由域名管理员签发，例如内网服务器可使用 DNS-01 验证。手动 DNS-01 签发**不会自动续期**；上线前记录到期日、实际续期和 Nginx 重载方案。不要让参与者忽略证书错误。

这套部署只保证**连着校网的设备**可用同一网址答题；校外蜂窝网络对服务器域名可能无法访问。原 `x-lab.game.elliotttzhang.cn` 不需要改动，校外访问它仍会看到 GitHub Pages 说明页。若需校外也可答题，必须另外有可从公网访问的反向代理/网关，此手册不宣称已完成。

## 安装与常驻运行

在服务器上安装 Node.js **24.19.0+ 的 24.x**、Nginx、Git；确认 `node --version`，然后检查真实 Node 路径。以下按 `/usr/bin/node` 编写服务文件，若服务器 Node 安装在其他路径，**先修改**服务文件中的 `ExecStart`，不能照搬本机 nvm 的路径。以有管理权限的操作员执行以下操作：

```bash
sudo useradd --system --home-dir /opt/xlab-annual-quiz --shell /usr/sbin/nologin xlab-game
sudo mkdir -p /opt /var/lib/xlab-annual-quiz /etc/xlab-annual-quiz
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

运行 `node scripts/admin-password.mjs`，**在服务器终端交互输入**至少 16 字符的管理口令，只把生成的哈希填入 `/etc/xlab-annual-quiz/game.env` 的 `ADMIN_PASSWORD_HASH=`；将 `PUBLIC_ORIGIN` 改为**实际服务器 HTTPS 域名**，不要保留模板中的 `quiz.campus.example.edu.cn`。不要在聊天、脚本或 Git 提交中留明文口令。这个文件应由 root 保管，允许 systemd 读取：

```bash
sudo chmod 600 /etc/xlab-annual-quiz/game.env
sudo chown -R xlab-game:xlab-game /opt/xlab-annual-quiz
sudo systemctl daemon-reload
sudo systemctl enable --now xlab-annual-quiz
sudo systemctl status xlab-annual-quiz
curl -fsS http://127.0.0.1:4173/api/health
```

此时只是本机后端就绪。把**实际服务器域名**及**已签发证书的实际路径**填到 `deploy/campus/xlab-annual-quiz.nginx.conf` 的 `server_name`、`ssl_certificate`、`ssl_certificate_key`；这四处要和 `PUBLIC_ORIGIN` 完全对应。安装到 Nginx 的站点目录，先测试配置再重载（下例为 Debian/Ubuntu 的目录，其他发行版按实际目录调整）：

```bash
sudo cp deploy/campus/xlab-annual-quiz.nginx.conf /etc/nginx/sites-available/xlab-annual-quiz
sudo ln -s /etc/nginx/sites-available/xlab-annual-quiz /etc/nginx/sites-enabled/xlab-annual-quiz
sudo nginx -t
sudo systemctl reload nginx
```

确保校网防火墙允许到服务器的 443，但不要开放 4173。后台浏览器与玩家使用**同一个 HTTPS 域名**；不需要在校网服务器上给每个人开账号，也不要把服务器的 `127.0.0.1` 发到微信群。

## 真正上线前的验证

在连着**会场校网**的手机（包括微信内浏览器）和个人电脑上检查所选域名解析到固定校网 IP，且证书无警告。下例的 `quiz.campus.example.edu.cn` **仅为占位符**，每处都换成实际服务器域名：

```bash
dig +short quiz.campus.example.edu.cn
curl -fsS https://quiz.campus.example.edu.cn/api/health
cd /opt/xlab-annual-quiz
npm run verify:campus -- https://quiz.campus.example.edu.cn
```

自检必须同时返回 `health/player/admin/display: true`；之后用两个独立设备验证注册、退出、换机登录、管理员开轮、五分钟自动收卷、积分排名和抽奖。用**独立演练数据库**测四轮完整流程，勿将测试题、账号和奖品导入正式库。正式库至少导入审核后的 30 道题及真实奖品才能使用。再次重启 `sudo systemctl restart xlab-annual-quiz`，确认账号/分数仍在，再验收 200 人连接与最后一秒集中交卷。

`systemctl enable --now` 保证开机自动启动；`Restart=always` 保证异常退出后重启，**不保证服务器断电、磁盘损坏、校网故障时持续可用**。定期将 `backup-latest.sqlite` 的已校验快照复制到独立介质/备用服务器，不能只保存同机副本。查看实时日志：`sudo journalctl -u xlab-annual-quiz -f`；应用健康检查失败时核查服务、Nginx、DNS、证书、磁盘空间和校网隔离。更新代码前先做备份和恢复演练，确认题库与状态不被演练污染。

## 域名不会自动生效的边界

服务器真实域名、IP、证书和登录方式不在仓库里，无法远程代填；在这些信息到位并通过真实设备验收前，**不要把任何域名宣称为正式答题入口**。不能仅推送 GitHub 代码就使运行中的服务器自动更新，也不能靠 Pages 的 yml 承载游戏。所选服务器域名如无有效证书或校网解析，需要学校网络管理员协助，不能通过浏览器跳过 TLS 警告解决。
