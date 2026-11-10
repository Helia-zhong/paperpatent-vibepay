# PaperPatent VibePay

**按果微付的专利交底书与科研论文精修商业工作台 · Pay-per-result patent and research editing workbench**

面向支付宝 AI 付 PAYATHON 2026 Vibe Pay 主赛道。React + Vite 前端、Express 服务端、SQLite 订单账本，默认本地端口 **3002**。

Built for the Alipay AI Pay PAYATHON 2026 Vibe Pay track, with React, Vite, Express, and a SQLite transaction ledger. Local development runs on port **3002**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Helia-zhong/paperpatent-vibepay)

## 评委快速体验 / Judge walkthrough

1. 选择专利、论文、结题报告或 SLA 退款演练案卷，查看免费专家诊断。
2. 在「AI 成果交付」内联收银条点击支付宝解锁，或选择单次、积分包、Pro 三模收银台。
3. 点击顶部 **「一键评委全链路商业演练」**，自动验证下单 → 仿真支付 → 服务端查询 → SLA 校验 → 解锁下载 → 重复回调拦截 → SLA 全额退款与撤权。
4. 在账本核对实收、Token 成本、利润和权益状态；打开 API 检视器查看请求、签名摘要与响应，导出 PNG 财务凭证。

Choose a case, read the free expert preview, and unlock through the inline Alipay checkout or the three-mode cashier. The **1-Click VibePay Auto-Pilot** runs the complete simulated payment, verification, delivery, idempotency, and refund journey. The ledger exposes revenue, cost, margin, and entitlement status; the API inspector shows payment messages and signature digests.

## 本地运行 / Run locally

需要 **Node.js 24+**（使用内置 `node:sqlite`）。Requires **Node.js 24+** for the built-in SQLite module.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

打开 [http://localhost:3002](http://localhost:3002)。无需密钥即可使用支付仿真与预设 AI 交付物。Open the local URL; no credentials are required for the simulator and preset AI outputs.

```powershell
npm run build
$env:NODE_ENV='production'
npm start
```

验证命令 / Validation:

```powershell
npm test
npm run check
```

## Render 部署 / Deploy on Render

仓库提供 [render.yaml](render.yaml)，创建 **Free Web Service**：Node.js 24、`npm ci --include=dev && npm run build` 构建、`npm start` 启动，健康检查路径 `/api/health`。服务读取 Render 注入的 `PORT`；本地默认仍为 3002。

The included Blueprint deploys a **free** Node.js 24 web service with a production build and `/api/health` health check. The server respects Render's assigned `PORT`.

1. 点击上方 Deploy to Render，使用 GitHub 登录并授权该公开仓库。
2. 检查免费方案与预设环境变量，创建 Blueprint 服务。
3. 等待构建上线，访问服务的 HTTPS 地址，执行一键演练并检查 `/api/health`。

Click the deploy button, authorize the repository, retain the free plan and supplied variables, and create the Blueprint. After deployment, open its HTTPS URL and run Auto-Pilot.

`DEMO_MODE=true` 强制使用支付仿真及预设 AI 内容；评委零配置即可演示。默认数据库 `/tmp/paperpatent-demo.sqlite` 使用免费实例临时存储，**重启、重新部署后订单与权益可能清空**。免费服务闲置后可能休眠，首次访问需等待启动。此 Blueprint 不创建付费磁盘或付费实例。

`DEMO_MODE=true` forces simulated payments and preset AI outputs. The database uses ephemeral storage at `/tmp/paperpatent-demo.sqlite`; **orders and entitlements can reset after restarts or deployments**. Free instances may sleep when idle, so the first request can take time. The Blueprint provisions no paid disk or paid service.

## 商业闭环 / Commercial flow

| 模式 / Mode | 价格与权益 / Price and entitlement |
| --- | --- |
| 单次 / One-off | 专利 Patent ¥2.80；论文 Paper ¥1.99；结题报告 Project report ¥1.50 |
| 科研积分 / Credits | ¥9.90 / 100 点，每次交付扣 10 点 / 100 credits; 10 per delivery |
| Pro | ¥29.90 / 30 天预付权益 / 30-day prepaid access |
| SLA | ≥85 分解锁；演练案卷 58 分触发全额退款与撤权 / Unlock at ≥85; the 58-point demo triggers a full refund and revocation |

服务端订单查询或通过 RSA2 验签的异步通知确认 `TRADE_SUCCESS` 后，才能执行 SLA 校验与权益放行。浏览器支付返回页不能开通权益。订单、回调、扣点与退款均实施幂等处理。交付物支持 Markdown、LaTeX、SVG、DOCX 与 ZIP；退款后下载访问被撤销。

Only a server-side payment query or a verified RSA2 notification confirming `TRADE_SUCCESS` can advance the SLA check and entitlement grant. A browser return URL cannot unlock content. Orders, callbacks, credit deductions, and refunds are idempotent. Deliverables include Markdown, LaTeX, SVG, DOCX, and ZIP; refunds revoke download access.

**Pro 当前是预付月度使用权益。自动续费扣款需要另外签约并接入支付宝对应周期扣款产品。** Pro is prepaid monthly access; recurring debits require a separate Alipay product agreement and integration.

## 支付与 AI 配置 / Payment and AI configuration

公开演示保持 `DEMO_MODE=true`。如需自行联调，在本地或自己的服务上关闭演示模式，并参考 [.env.example](.env.example) 配置：

Keep public demos in `DEMO_MODE=true`. For your own integration, disable demo mode and configure:

| 变量 / Variable | 用途 / Purpose |
| --- | --- |
| `ALIPAY_APP_ID` | 支付宝开放平台沙箱应用 / Alipay sandbox application |
| `ALIPAY_PRIVATE_KEY` | 应用 RSA2 私钥 / Application RSA2 private key |
| `ALIPAY_PUBLIC_KEY` | 支付宝公钥 / Alipay public key |
| `ALIPAY_SELLER_ID` | 可选收款方校验 / Optional seller validation |
| `ALIPAY_GATEWAY` | 默认开放平台沙箱网关 / Sandbox gateway by default |
| `ALIPAY_NOTIFY_URL` | 公网 HTTPS 异步通知地址 / Public HTTPS notification endpoint |
| `ALIPAY_RETURN_URL` | 浏览器返回地址 / Browser return URL |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | 兼容 Chat Completions 的模型服务 / Compatible model provider |
| `AI_INPUT_CNY_PER_1M`, `AI_OUTPUT_CNY_PER_1M` | 模型输入、输出实际计费费率 / Actual model input/output rates |
| `DATABASE_PATH` | 服务端默认 `./data/paperpatent.db`；环境示例使用 `.sqlite` / Server default; the environment example uses `.sqlite` |

密钥支持 PEM，多行环境变量可用 `\n`。支付宝凭据不完整时自动使用本地 RSA2 仿真引擎，模拟 `alipay.trade.page.pay`、`alipay.trade.query`、`alipay.trade.refund` 状态。AI 密钥未配置时，预设诊断和交付物明确标注「演示内容」。`.env`、私钥、运行数据库均被 `.gitignore` 排除，请勿提交或放入浏览器代码。

PEM keys support escaped newlines. Missing payment credentials select the local RSA2 simulator; missing AI credentials select clearly labeled demo content. Environment files, private keys, and runtime databases are excluded from Git and must remain server-side.

准备阶段已成功执行 `npx -y @alipay/alipay-aipay@latest install`，安装官方接入 Skill v1.8.3。实现参考 [支付宝 Vibe Pay 官方文档](https://aipay.alipay.com/docs/vibe-pay.html) 与 [AI 网页应用收款接入指南](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/ai-web-app-payment-integration-guide.html)。**仿真结果不代表真实支付宝沙箱资金链路验证、商户签约或官方认证。**

The official Alipay installer completed successfully with Skill v1.8.3. The implementation follows the linked official guides. **Simulator validation does not establish successful real Alipay sandbox transactions, merchant onboarding, or official certification.**

## 测试范围 / Test coverage

**22/22 项自动化测试通过**。原有 20 项覆盖支付前拦截、支付后查询、交付下载、回调与并发核销幂等、SLA 自动退款、退款重试、积分扣减、订阅复用、跨会话隔离、通知验签和模型输出校验。新增 2 项验证健康检查不创建会话，以及真实 App 在虚拟 DOM 中的内联收银流程：快捷单次买断、查询前锁定、核销后解锁、收银台跳转与焦点。测试使用独立临时或内存数据库，不修改演示数据。

**22/22 automated tests pass**: the original 20 cover payments, protected delivery, idempotency, refunds and retries, credits, subscriptions, session isolation, signatures, and model output validation. Two additions verify that health checks create no session and exercise the real App in a virtual DOM: inline one-off checkout, locked access before verification, unlock after verification, and cashier scrolling and focus. Tests use isolated temporary or in-memory databases.

## 许可 / License

[MIT License](LICENSE) · Copyright © 2026 PaperPatent VibePay contributors.
