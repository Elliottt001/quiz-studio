# X-Lab 无限游戏

2026 年度大会答题及虚拟小球抽奖系统。**一个持续运行的 Node.js 服务**提供玩家页、管理员控制台、大屏页、API 和 SQLite 数据库。校网内同域名运行完整游戏请按[校网服务器部署说明](/Users/bytedance/Projects/xlab-annual-quiz/docs/campus-server-deploy.md)部署；GitHub Pages 只能提供静态说明页。

## 当前状态

功能开发版已包含：

- 微信群统一链接自由注册，真名、昵称、年级（2019–2025）和四个团队；新玩家设置密码并获得独立登录码，可从手机、个人电脑或公用电脑登录原账号，使用后退出。遗忘凭据由管理员发一次性恢复码。
- 6／10／9／5 道题，29 道单选和最后一道 5–120 字计分感受题；只有管理员点击开始会开轮，服务端从实际开题起计满 300 秒自动收卷、计分、公布已收卷排名。
- 答题分、额外分、作废重算、参奖资格、冻结奖池、三等奖至大奖顺序抽取，以及每人最多中一个奖。
- 每位有资格者的虚拟球数是 `10 + 总分 / 10`，每次从未中奖者的剩余球中等概率抽一颗；中奖后移除该人的全部球，结果先保存再揭晓。
- 管理员专用 JSON 导出、轮次／抽奖备份、深蓝虹彩主视觉的玩家端与大屏端。

**尚未完成活动上线验收**：校网服务器地址、内网 DNS 覆写、有效 HTTPS 证书、正式题库、真实奖品数量与现场并发验证仍需落实。不要把 GitHub Pages 说明页或开发电脑链接作为正式答题入口。

## 本地开发

要求 Node.js **24.19.0 或更新的 24.x**。本项目只有 Node 内置 API，无 `npm install` 步骤。开发测试使用本机回环地址，不提供校网访问：

```bash
cd /Users/bytedance/Projects/xlab-annual-quiz
npm test
npm run check
npm run build
npm start
```

- 玩家端：`http://127.0.0.1:4173/`
- 管理端：`http://127.0.0.1:4173/admin.html`
- 大屏端：`http://127.0.0.1:4173/display.html`

要使用管理端，先执行 `node scripts/admin-password.mjs`，在本机终端输入至少 16 字符的管理员口令；把**输出的哈希**放进忽略 Git 的 `.env.local`，不要把明文口令写入文件。可参考 [.env.example](/Users/bytedance/Projects/xlab-annual-quiz/.env.example)。运行目录中的 `data/` 和 `.env.local` 均不进入 Git。

## 正式题库

在后台导入已审核的 JSON 文件，顶层结构为 `{ "questions": [...] }` 或直接包含 30 道题的数组。每题字段：

| 字段 | 单选题 | 感受填空 |
|---|---|---|
| `id` | 全库唯一，建议 `q1` 至 `q30` | `q30` |
| `roundId` | 1–4，题数依次为 6／10／9／5 | 4 |
| `position` | 轮内从 1 开始 | 5 |
| `kind` | `"choice"` | `"reflection"` |
| `prompt` | 真实分享及资料支持的题干 | 经公示的训练营感受题 |
| `options` | 长度恰好为 4 的字符串数组 | 不提供 |
| `correctOption` | 0–3，对应 A–D | 不提供 |
| `explanation` | 收卷后显示的答案解析 | 可填写自动给分解释 |
| `source` | 对应讲稿／文档章节 | 可填写活动规则来源 |

示例字段结构（**不是正式题目**）：

```json
{
  "id": "q1",
  "roundId": 1,
  "position": 1,
  "kind": "choice",
  "prompt": "请替换为已审核的真实题目",
  "options": ["选项 A", "选项 B", "选项 C", "选项 D"],
  "correctOption": 0,
  "explanation": "填写正确答案及依据",
  "source": "填写材料名称和页码"
}
```

**必须填齐真实 30 题**才能开启正式轮次；测试代码中的题库只是自动化夹具，不会启动时导入正式库。实际题目、截止前资料权限和四轮题量须经负责人审核。管理端一旦开启任意轮，便不能替换正式题库。当前 Web 应用不会自动采集分享或调用 AI 编题。

## 部署和应急

本次目标部署方式见[校网服务器部署说明](/Users/bytedance/Projects/xlab-annual-quiz/docs/campus-server-deploy.md)；若日后需要校外访问，参见[公网服务迁移说明](/Users/bytedance/Projects/xlab-annual-quiz/docs/cloud-deploy.md)。开发时可按[本地运行手册](/Users/bytedance/Projects/xlab-annual-quiz/docs/runbook.md)验证流程；非本机地址必须配置直连 TLS 或显式可信 HTTPS 代理及管理员口令，否则服务器拒绝监听。

### GitHub Pages 公开说明页

`npm run build:pages` 只打包 `pages/index.html` 与两张视觉图到 `dist-pages/`；现有 GitHub Pages 工作流发布的是**校外说明页**，不承载正式答题。若校网 DNS 为同名域名覆写至校内服务器，校内看到完整游戏，校外仍看到说明页。切换校内 DNS 前先验证后端、443 和有效证书。
