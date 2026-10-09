# 校网服务器部署：同一域名提供完整游戏

适用于 **Linux + systemd + Nginx**、参会设备均能访问校网内网服务器的情形。GitHub 只保存程序；唯一的生产 Node 进程和 SQLite 数据库均运行在校网服务器。玩家、管理员与大屏都使用 `https://x-lab.game.elliotttzhang.cn/`，分别访问 `/`、`/admin.html`、`/display.html`。普通电脑与公用电脑完全一样，都用个人登录码和密码进入，操作后退出。管理员用独立口令登录后台。

## 前提：网络和证书

向校网管理员确认：服务器有**固定校网 IP**，会场 Wi-Fi 客户端能访问该 IP 的 TCP 443（没有客户端隔离），校网 DNS 能为 `x-lab.game.elliotttzhang.cn` 做**校网内覆写 A/AAAA 记录**指向该服务器。公网权威 DNS 当前仍指向 GitHub Pages；仅修改火山引擎的公网记录，不会自动修改学校 DNS。不要将私网 IP 直接填入当前 CNAME，也不要把 `4173` 端口暴露到校网。

Nginx 必须使用手机/微信信任的、**针对该域名的有效证书**。内网服务器无法依赖公网 HTTP-01 回连时，用域名公网 DNS 的 **DNS-01** 验证签发证书；火山引擎的 DNS TXT 记录和校网内覆写 A 记录是不同设置。可使用学校已有的有效证书，或由有域名 DNS 权限的人员选支持该 DNS 平台的 ACME DNS 插件自动续期。手动 DNS-01 签发只适合临时演练，**不会自动续期**；上线前记录到期日、实际续期和 Nginx 重载方案。不要让参与者忽略证书错误。

这套部署只保证**连着校网的设备**可用同一网址答题；校外蜂窝网络在公网仍会看到 GitHub Pages 说明页。若需校外也可答题，必须另外有可从公网访问的反向代理/网关，并做公网域名与 TLS 切换，此手册不宣称已完成。

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

运行 `node scripts/admin-password.mjs`，**在服务器终端交互输入**至少 16 字符的管理口令，只把生成的哈希填入 `/etc/xlab-annual-quiz/game.env` 的 `ADMIN_PASSWORD_HASH=`；不要在聊天、脚本或 Git 提交中留明文口令。这个文件应由 root 保管，允许 systemd 读取：

```bash
sudo chmod 600 /etc/xlab-annual-quiz/game.env
sudo chown -R xlab-game:xlab-game /opt/xlab-annual-quiz
sudo systemctl daemon-reload
sudo systemctl enable --now xlab-annual-quiz
sudo systemctl status xlab-annual-quiz
curl -fsS http://127.0.0.1:4173/api/health
```

此时只是本机后端就绪；手机还不能从公网域名直接访问。把**已签发证书的实际路径**填到 `deploy/campus/xlab-annual-quiz.nginx.conf`，安装到 Nginx 的站点目录，先测试配置再重载（下例为 Debian/Ubuntu 的目录，其他发行版按实际目录调整）：

```bash
sudo cp deploy/campus/xlab-annual-quiz.nginx.conf /etc/nginx/sites-available/xlab-annual-quiz
sudo ln -s /etc/nginx/sites-available/xlab-annual-quiz /etc/nginx/sites-enabled/xlab-annual-quiz
sudo nginx -t
sudo systemctl reload nginx
```

确保校网防火墙允许到服务器的 443，但不要开放 4173。后台浏览器与玩家使用**同一个 HTTPS 域名**；不需要在校网服务器上给每个人开账号，也不要把服务器的 `127.0.0.1` 发到微信群。

## 真正上线前的验证

在连着**会场校网**的手机（包括微信内浏览器）和个人电脑上检查 DNS 指向固定校网 IP，而不是 `elliottt001.github.io`，且证书无警告。连接蜂窝网络做对照，确定没有把旧 Pages 指引误判成游戏。可在校网电脑执行：

```bash
dig +short x-lab.game.elliotttzhang.cn
curl -fsS https://x-lab.game.elliotttzhang.cn/api/health
cd /opt/xlab-annual-quiz
npm run verify:campus
```

自检必须同时返回 `health/player/admin/display: true`；之后用两个独立设备验证注册、退出、换机登录、管理员开轮、五分钟自动收卷、积分排名和抽奖。用**独立演练数据库**测四轮完整流程，勿将测试题、账号和奖品导入正式库。正式库至少导入审核后的 30 道题及真实奖品才能使用。再次重启 `sudo systemctl restart xlab-annual-quiz`，确认账号/分数仍在，再验收 200 人连接与最后一秒集中交卷。

`systemctl enable --now` 保证开机自动启动；`Restart=always` 保证异常退出后重启，**不保证服务器断电、磁盘损坏、校网故障时持续可用**。定期将 `backup-latest.sqlite` 的已校验快照复制到独立介质/备用服务器，不能只保存同机副本。查看实时日志：`sudo journalctl -u xlab-annual-quiz -f`；应用健康检查失败时核查服务、Nginx、DNS、证书、磁盘空间和校网隔离。更新代码前先做备份和恢复演练，确认题库与状态不被演练污染。

## 域名不会自动生效的边界

服务器 IP、学校 DNS 权限、证书和服务器登录方式不在仓库里，无法远程代填；在这四项到位并通过真实设备验收前，**当前公网域名仍是静态说明页**。不能仅推送 GitHub 代码就使运行中的服务器自动更新，也不能靠 Pages 的 yml 承载游戏。若学校不能覆写此域名的 DNS，则需另选可信 HTTPS 校网域名或增设公网网关，不能通过浏览器跳过 TLS 警告解决。
