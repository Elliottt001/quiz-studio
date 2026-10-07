# GitHub Pages 与火山引擎 DNS 配置

公开地址：`x-lab.game.elliotttzhang.cn`

## 发布内容与运行边界

本仓库的 `.github/workflows/pages.yml` 只部署 `pages/index.html` 和两张位于 `public/brand/` 的图片。Pages 上是**公开指引页**，不运行 `src/server/`，也不处理玩家注册、答卷、积分或抽奖。正式游戏仍运行在会场专用电脑；如果把 `public/` 原样部署到 Pages，玩家打开页面会找不到 `/api/*`，游戏无法使用。

工作流使用 **GitHub Actions** 作为 Pages 来源。在此模式下，仓库里的 `CNAME` 文件不是设置自定义域名的办法；需在仓库 `Settings → Pages → Custom domain` 配置，或通过 GitHub Pages API 配置。项目首次发布后，可在 `Settings → Pages` 核查域名和 `Enforce HTTPS` 状态。

## 公网 DNS：火山引擎控制台

先确认 `elliotttzhang.cn` 的 NS 已委托到火山引擎。当前查询到 `ns1.volcengine-dns.com`、`ns2.volcengine-dns.com`。若后来换了 DNS 服务商，请到新的权威 DNS 平台操作。

1. 登录火山引擎控制台，打开 **TrafficRoute DNS 套件 → 云解析 DNS → 公网域名管理**。
2. 点击域名 **`elliotttzhang.cn`**，进入 **记录管理 → 添加记录**。不要误进“私网解析 PrivateZone”，也不要新建 `game.elliotttzhang.cn` 作为独立 DNS Zone，除非真的专门做了 NS 委派。
3. 填入下面一条公网记录。界面若将“域名”和“主机记录”分开，主机记录填完整前缀 `x-lab.game`，**不是只填 `x-lab`**：

   | 控制台字段 | 填写值 |
   |---|---|
   | 当前管理域名 | `elliotttzhang.cn` |
   | 域名／主机记录 | `x-lab.game` |
   | 记录类型 | `CNAME` |
   | 线路 | `默认` |
   | TTL | `10 分钟` / `600 秒` |
   | 记录值 | `Elliottt001.github.io` |

4. 点击 **添加记录值**（若界面要求）并 **提交**。记录值不带 `https://`、仓库名、路径或端口。不要为同一个 `x-lab.game` 名称再添加 A／AAAA 记录；若此前已有冲突记录，先核对用途再处理，勿盲删别人的记录。
5. 验证：

   ```bash
   dig +short NS elliotttzhang.cn
   dig +short CNAME x-lab.game.elliotttzhang.cn
   dig @ns1.volcengine-dns.com +short CNAME x-lab.game.elliotttzhang.cn
   ```

   后两条最终应返回 `Elliottt001.github.io.`（DNS 输出通常带结尾点）。解析生效可能受 TTL 与缓存影响，不要一提交就把打不开当成 GitHub 部署故障。

## GitHub 设置检查

仓库：`Elliottt001/xlab-annual-quiz`。打开 **Settings → Pages**，确认 **Build and deployment → Source** 是 `GitHub Actions`，**Custom domain** 为 `x-lab.game.elliotttzhang.cn`。打开 **Actions**，确认 `Publish public event page` 工作流成功。DNS 生效及证书签发后，在 Pages 设置中启用／确认 **Enforce HTTPS**。若 GitHub 显示域名验证要求，按照页面提供的 TXT 名称和值添加记录；TXT 值由 GitHub 动态生成，不能凭本说明虚构。

建议在 GitHub 个人设置的 Pages／Domains 中验证域名所有权，以降低子域名接管风险；不要使用 `*.elliotttzhang.cn` 通配 CNAME 指向 GitHub。此步骤与仓库 Pages 的 Custom domain 是两件事。

## 会场要直接用同一个域名答题？

**仅配置上述公网 CNAME 不够。** 公众访问 `x-lab.game.elliotttzhang.cn` 会到 GitHub Pages 指引页，而不会连接现场电脑。若希望同一域名在校网内直接打开完整游戏，还必须由校网管理员设置**内网 DNS 覆盖／分视图解析**：仅在会场校网内，把该域名解析为游戏主机的内网 IP，同时给主机配置该域名有效、受手机信任的 HTTPS 证书；现场测试微信内浏览器及至少两部手机。公网继续保持 CNAME 指向 GitHub Pages。校网通常无法由火山引擎的**公网** DNS 控制台替学校内网代配这一条。

如果学校不支持内网 DNS 覆盖，继续保留 Pages 公开指引页，但从微信群及现场二维码**单独**发放校网可访问的 HTTPS 游戏地址。不能把 `192.168.x.x` 等私网 IP 写入公网 CNAME，也不要让玩家点击证书警告继续。
