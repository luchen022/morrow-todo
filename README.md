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

1. 创建 D1：`pnpm wrangler d1 create morrow-db`
2. 把返回的 `database_id` 写入 `wrangler.jsonc`
3. 设置密钥：`pnpm wrangler secret put APP_PASSWORD`、`pnpm wrangler secret put SESSION_SECRET` 和 `pnpm wrangler secret put RESEND_API_KEY`
4. 应用迁移：`pnpm db:migrate:remote`
5. 在 Resend 控制台创建 API Key 并验证发件域名
6. 部署：`pnpm deploy`

首次登录后，在设置中填写收件邮箱与使用已验证域名的发件地址，然后发送测试邮件。`RESEND_API_KEY` 只能通过 Worker Secret 或本地 `.dev.vars` 提供，不能写入源码。

## 安全说明

不要提交 `.dev.vars`。生产环境必须使用足够长且不重复的 `APP_PASSWORD` 与 `SESSION_SECRET`。Morrow 使用 HttpOnly、SameSite=Strict 会话 Cookie，并对状态变更请求执行同源检查。
