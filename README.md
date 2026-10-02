# Morrow

Morrow 是一款面向个人使用的开源任务管理工具，灵感来自 Vikunja，运行在 Cloudflare Workers 和 D1 上，并通过 Resend 发送提醒邮件。

## 已实现

- 项目、任务、子任务、标签和优先级
- 收件箱、今天、即将到期、已完成视图
- 截止时间、独立提醒时间和重复任务
- 站内通知和 Resend 邮件提醒
- 单用户密码登录、安全会话 Cookie
- 响应式界面和 PWA 安装
- D1 数据库迁移和每分钟 Cron 提醒任务

## 本地启动

1. 安装依赖：`pnpm install`
2. 复制 `.dev.vars.example` 为 `.dev.vars` 并填写密码和会话密钥
3. 初始化本地数据库：`pnpm db:migrate:local`
4. 一个终端运行 API：`pnpm wrangler dev --local --port 8787`
5. 另一个终端运行前端：`pnpm dev`

## 部署到 Cloudflare

1. 在 Workers 和 Pages 中导入 GitHub 仓库，Worker 名称使用 `morrow-todo`，生产分支选择 `main`，根目录使用仓库根目录。
2. 构建命令留空，部署命令填写 `pnpm deploy`。关闭非生产分支的预览构建。
3. 首次部署先发布应用。此时尚未连接数据库，页面接口会提示完成配置。
4. 在 D1 页面创建数据库（建议名称 `morrow-db`），然后进入 Worker → Bindings → Add binding → D1，变量名填写 **`DB`**，从列表中选择数据库。
5. 在 Worker → Settings → Variables and Secrets 中添加三个 **Secret**：`APP_PASSWORD`（登录密码）、`SESSION_SECRET`（至少 32 位随机字符串）、`RESEND_API_KEY`（Resend 密钥）。这些是运行时密钥，不是 Build secrets。
6. 重新运行最新构建。部署脚本读取网页上选定的 `DB` 绑定，自动执行数据库迁移，然后部署应用。无需将数据库 ID 写入源码。
7. 在 Resend 控制台验证发件域名。首次登录后在应用设置中填写收件邮箱和发件地址，发送测试邮件。

Workers Builds 的构建环境需要提供 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。若构建日志提示缺少它们，请在 **Build variables and secrets** 中分别添加账号 ID 和部署 Token（Secret）。部署 Token 需要 Workers Scripts 读取/编辑权限和 D1 编辑权限；Cloudflare 自动生成的构建 Token 如果没有 D1 权限，需要在 API Tokens 页面补充。无需提供这些值给仓库维护者。

后续推送 `main` 时会自动迁移和部署。脚本每次读取最新的网页绑定；读取失败会停止发布，避免误删数据库绑定。仓库中的 `wrangler.jsonc` 的 D1 配置仅用于本地开发，生产请使用 `pnpm deploy`，不要直接运行 `wrangler deploy`。部署时产生的临时配置会自动删除并已被 Git 忽略。

`RESEND_API_KEY` 只能通过 Worker Secret 或本地 `.dev.vars` 提供，不能写入源码。

## 安全说明

不要提交 `.dev.vars`。生产环境必须使用足够长且不重复的 `APP_PASSWORD` 与 `SESSION_SECRET`。Morrow 使用 HttpOnly、SameSite=Strict 会话 Cookie，并对状态变更请求执行同源检查。
