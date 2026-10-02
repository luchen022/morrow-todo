import { Resend } from "resend";
import { MAX_BACKUP_BYTES, backupCounts, exportBackup, readBackup, restoreBackup, validateBackup } from "./backup";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type TaskRow = {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  status: "open" | "done";
  priority: number;
  start_at: string | null;
  due_at: string | null;
  reminder_at: string | null;
  reminder_sent_at: string | null;
  recurrence_rule: "daily" | "weekly" | "monthly" | "yearly" | null;
  completed_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  tag_names?: string | null;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
};

type ReminderRow = TaskRow & { project_name: string | null };

const SESSION_COOKIE = "morrow_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

function json(data: JsonValue, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers }
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function parseCookies(request: Request): Record<string, string> {
  const cookie = request.headers.get("Cookie") ?? "";
  return Object.fromEntries(
    cookie
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  const chars = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(chars).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function createSession(secret: string): Promise<string> {
  const payload = `${Date.now() + SESSION_AGE_SECONDS * 1000}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !env.SESSION_SECRET) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return false;
  return secureEqual(signature, await hmac(expires, env.SESSION_SECRET));
}

function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const target = new URL(request.url);
  const source = new URL(origin);
  if (source.origin === target.origin) return true;
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  return localHosts.has(source.hostname) && localHosts.has(target.hostname);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    throw new Error("请求必须使用 JSON 格式");
  }
  return request.json<Record<string, unknown>>();
}

function textValue(value: unknown, max = 5000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullableDate(value: unknown): string | null {
  if (value === null || value === "" || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function isoNow(): string {
  return new Date().toISOString();
}

function taskJson(row: TaskRow): JsonValue {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startAt: row.start_at,
    dueAt: row.due_at,
    reminderAt: row.reminder_at,
    reminderSentAt: row.reminder_sent_at,
    recurrenceRule: row.recurrence_rule,
    completedAt: row.completed_at,
    position: row.position,
    tags: row.tag_names ? row.tag_names.split("\u001f") : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function projectJson(row: ProjectRow): JsonValue {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function syncTaskTags(db: D1Database, taskId: string, values: unknown): Promise<void> {
  const names = Array.isArray(values)
    ? [...new Set(values.map((item) => textValue(item, 40)).filter(Boolean))].slice(0, 12)
    : [];
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(taskId)
  ];
  for (const name of names) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)")
        .bind(crypto.randomUUID(), name, "#8972a5", isoNow())
    );
  }
  await db.batch(statements);
  for (const name of names) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE"
      )
      .bind(taskId, name)
      .run();
  }
}

async function getTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return db
    .prepare(
      `SELECT t.*, GROUP_CONCAT(tags.name, char(31)) AS tag_names
       FROM tasks t
       LEFT JOIN task_tags tt ON tt.task_id = t.id
       LEFT JOIN tags ON tags.id = tt.tag_id
       WHERE t.id = ?
       GROUP BY t.id LIMIT 1`
    )
    .bind(id)
    .first<TaskRow>();
}

function advanceDate(value: string | null, rule: TaskRow["recurrence_rule"]): string | null {
  if (!value || !rule) return value;
  const date = new Date(value);
  if (rule === "daily") date.setUTCDate(date.getUTCDate() + 1);
  if (rule === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  if (rule === "monthly") date.setUTCMonth(date.getUTCMonth() + 1);
  if (rule === "yearly") date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

async function createRecurringSuccessor(db: D1Database, task: TaskRow): Promise<void> {
  if (!task.recurrence_rule || !task.due_at) return;
  const id = crypto.randomUUID();
  const now = isoNow();
  const nextDue = advanceDate(task.due_at, task.recurrence_rule);
  const nextStart = advanceDate(task.start_at, task.recurrence_rule);
  const nextReminder = advanceDate(task.reminder_at, task.recurrence_rule);
  await db.batch([
    db
      .prepare(
        `INSERT INTO tasks
          (id, project_id, parent_id, title, description, status, priority, start_at, due_at, reminder_at,
           recurrence_rule, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        task.project_id,
        task.parent_id,
        task.title,
        task.description,
        task.priority,
        nextStart,
        nextDue,
        nextReminder,
        task.recurrence_rule,
        task.position,
        now,
        now
      ),
    db
      .prepare("INSERT INTO task_tags (task_id, tag_id) SELECT ?, tag_id FROM task_tags WHERE task_id = ?")
      .bind(id, task.id)
  ]);
}

async function bootstrap(env: Env): Promise<Response> {
  const [projectResult, taskResult, tagResult, notificationResult, settingsResult] = await Promise.all([
    env.DB.prepare("SELECT * FROM projects ORDER BY position, created_at").all<ProjectRow>(),
    env.DB
      .prepare(
        `SELECT t.*, GROUP_CONCAT(tags.name, char(31)) AS tag_names
         FROM tasks t
         LEFT JOIN task_tags tt ON tt.task_id = t.id
         LEFT JOIN tags ON tags.id = tt.tag_id
         GROUP BY t.id
         ORDER BY t.status, COALESCE(t.due_at, '9999-12-31'), t.position, t.created_at DESC`
      )
      .all<TaskRow>(),
    env.DB.prepare("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE").all(),
    env.DB
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50")
      .all(),
    env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>()
  ]);
  const settings = Object.fromEntries(settingsResult.results.map((item) => [item.key, item.value]));
  return json({
    projects: projectResult.results.map(projectJson),
    tasks: taskResult.results.map(taskJson),
    tags: tagResult.results as unknown as JsonValue,
    notifications: notificationResult.results as unknown as JsonValue,
    settings
  });
}

async function createProject(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const name = textValue(body.name, 80);
  if (!name) return error("请输入项目名称");
  const id = crypto.randomUUID();
  const now = isoNow();
  const color = /^#[0-9a-f]{6}$/i.test(textValue(body.color, 7)) ? textValue(body.color, 7) : "#4f7c70";
  await env.DB
    .prepare(
      "INSERT INTO projects (id, name, description, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, name, textValue(body.description, 500), color, Number(body.position) || 0, now, now)
    .run();
  const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
  return json(projectJson(project!), 201);
}

async function updateProject(request: Request, env: Env, id: string): Promise<Response> {
  if (id === "inbox") return error("收件箱不能修改", 403);
  const body = await readBody(request);
  const existing = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
  if (!existing) return error("项目不存在", 404);
  const name = textValue(body.name, 80) || existing.name;
  const color = /^#[0-9a-f]{6}$/i.test(textValue(body.color, 7)) ? textValue(body.color, 7) : existing.color;
  await env.DB
    .prepare("UPDATE projects SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?")
    .bind(name, textValue(body.description, 500), color, isoNow(), id)
    .run();
  return json(projectJson((await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>())!));
}

async function deleteProject(env: Env, id: string): Promise<Response> {
  if (id === "inbox") return error("收件箱不能删除", 403);
  await env.DB.batch([
    env.DB.prepare("UPDATE tasks SET project_id = 'inbox', updated_at = ? WHERE project_id = ?").bind(isoNow(), id),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id)
  ]);
  return json({ ok: true });
}

async function createTask(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const title = textValue(body.title, 300);
  if (!title) return error("请输入任务内容");
  const id = crypto.randomUUID();
  const now = isoNow();
  const priority = Math.max(0, Math.min(4, Number(body.priority) || 0));
  const recurrence = ["daily", "weekly", "monthly", "yearly"].includes(String(body.recurrenceRule))
    ? String(body.recurrenceRule)
    : null;
  await env.DB
    .prepare(
      `INSERT INTO tasks
        (id, project_id, parent_id, title, description, priority, start_at, due_at, reminder_at,
         recurrence_rule, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      textValue(body.projectId, 80) || "inbox",
      textValue(body.parentId, 80) || null,
      title,
      textValue(body.description, 10000),
      priority,
      nullableDate(body.startAt),
      nullableDate(body.dueAt),
      nullableDate(body.reminderAt),
      recurrence,
      Number(body.position) || 0,
      now,
      now
    )
    .run();
  await syncTaskTags(env.DB, id, body.tags);
  return json(taskJson((await getTask(env.DB, id))!), 201);
}

async function updateTask(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readBody(request);
  const existing = await getTask(env.DB, id);
  if (!existing) return error("任务不存在", 404);
  const nextStatus = body.status === "done" ? "done" : body.status === "open" ? "open" : existing.status;
  const justCompleted = existing.status !== "done" && nextStatus === "done";
  const recurrence = body.recurrenceRule === null || body.recurrenceRule === ""
    ? null
    : ["daily", "weekly", "monthly", "yearly"].includes(String(body.recurrenceRule))
      ? String(body.recurrenceRule)
      : existing.recurrence_rule;
  const reminderAt = Object.hasOwn(body, "reminderAt") ? nullableDate(body.reminderAt) : existing.reminder_at;
  const reminderChanged = reminderAt !== existing.reminder_at;
  await env.DB
    .prepare(
      `UPDATE tasks SET project_id = ?, parent_id = ?, title = ?, description = ?, status = ?, priority = ?,
       start_at = ?, due_at = ?, reminder_at = ?, reminder_sent_at = ?, recurrence_rule = ?, completed_at = ?,
       position = ?, updated_at = ? WHERE id = ?`
    )
    .bind(
      textValue(body.projectId, 80) || existing.project_id || "inbox",
      Object.hasOwn(body, "parentId") ? textValue(body.parentId, 80) || null : existing.parent_id,
      textValue(body.title, 300) || existing.title,
      Object.hasOwn(body, "description") ? textValue(body.description, 10000) : existing.description,
      nextStatus,
      Object.hasOwn(body, "priority") ? Math.max(0, Math.min(4, Number(body.priority) || 0)) : existing.priority,
      Object.hasOwn(body, "startAt") ? nullableDate(body.startAt) : existing.start_at,
      Object.hasOwn(body, "dueAt") ? nullableDate(body.dueAt) : existing.due_at,
      reminderAt,
      reminderChanged ? null : existing.reminder_sent_at,
      recurrence,
      nextStatus === "done" ? existing.completed_at || isoNow() : null,
      Object.hasOwn(body, "position") ? Number(body.position) || 0 : existing.position,
      isoNow(),
      id
    )
    .run();
  if (Object.hasOwn(body, "tags")) await syncTaskTags(env.DB, id, body.tags);
  if (justCompleted) await createRecurringSuccessor(env.DB, { ...existing, recurrence_rule: recurrence as TaskRow["recurrence_rule"] });
  return json(taskJson((await getTask(env.DB, id))!));
}

async function deleteTask(env: Env, id: string): Promise<Response> {
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const allowed = ["timezone", "email_enabled", "email_to", "email_from"];
  const now = isoNow();
  const statements: D1PreparedStatement[] = [];
  for (const key of allowed) {
    if (!Object.hasOwn(body, key)) continue;
    let value = textValue(body[key], 320);
    if (key === "email_enabled") value = body[key] === true || body[key] === "true" ? "true" : "false";
    statements.push(
      env.DB
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(key, value, now)
    );
  }
  if (statements.length) await env.DB.batch(statements);
  const result = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return json(Object.fromEntries(result.results.map((item) => [item.key, item.value])) as JsonValue);
}

async function loadSettings(env: Env): Promise<Record<string, string>> {
  const result = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(result.results.map((item) => [item.key, item.value]));
}

async function sendEmail(
  env: Env,
  settings: Record<string, string>,
  subject: string,
  text: string,
  html: string,
  idempotencyKey: string,
  tags: { name: string; value: string }[]
): Promise<string> {
  if (!settings.email_to || !settings.email_from) throw new Error("请先配置发件人与收件邮箱");
  const resend = new Resend(env.RESEND_API_KEY);
  const { data, error: resendError } = await resend.emails.send({
    to: [settings.email_to],
    from: `Morrow <${settings.email_from}>`,
    subject,
    text,
    html,
    tags
  }, { idempotencyKey });
  if (resendError) throw new Error(resendError.message);
  if (!data?.id) throw new Error("Resend 未返回邮件 ID");
  return data.id;
}

async function testEmail(env: Env): Promise<Response> {
  const settings = await loadSettings(env);
  try {
    const emailId = await sendEmail(
      env,
      settings,
      "Morrow 邮件提醒测试",
      "邮件提醒已经配置成功。之后，Morrow 会在你设定的时间提醒你。",
      "<div style=\"font-family:system-ui;max-width:560px;margin:auto;padding:32px\"><h1 style=\"color:#1f4b43\">一切准备好了</h1><p>邮件提醒已经配置成功。之后，Morrow 会在你设定的时间提醒你。</p></div>",
      `test-email/${crypto.randomUUID()}`,
      [{ name: "category", value: "test" }]
    );
    return json({ ok: true, emailId });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "邮件发送失败", 502);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]!);
}

async function processReminders(env: Env): Promise<void> {
  const now = isoNow();
  const due = await env.DB
    .prepare(
      `SELECT t.*, p.name AS project_name
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.status = 'open' AND t.reminder_at IS NOT NULL AND t.reminder_at <= ? AND t.reminder_sent_at IS NULL
       ORDER BY t.reminder_at LIMIT 100`
    )
    .bind(now)
    .all<ReminderRow>();
  if (!due.results.length) return;
  const settings = await loadSettings(env);
  for (const task of due.results) {
    const notificationId = `reminder:${task.id}:${task.reminder_at}`;
    await env.DB
      .prepare("INSERT OR IGNORE INTO notifications (id, task_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(notificationId, task.id, "任务提醒", task.title, now)
      .run();
    if (settings.email_enabled === "true") {
      const dueText = task.due_at ? new Date(task.due_at).toLocaleString("zh-CN", { timeZone: settings.timezone || "Asia/Shanghai" }) : "未设置";
      try {
        await sendEmail(
          env,
          settings,
          `提醒：${task.title}`,
          `任务：${task.title}\n项目：${task.project_name || "收件箱"}\n截止时间：${dueText}`,
          `<div style=\"font-family:system-ui;max-width:560px;margin:auto;padding:32px\"><div style=\"color:#688b82;font-size:14px\">MORROW · 任务提醒</div><h1 style=\"color:#183f38;font-size:28px\">${escapeHtml(task.title)}</h1><p style=\"color:#5d6965\">项目：${escapeHtml(task.project_name || "收件箱")}<br>截止时间：${escapeHtml(dueText)}</p></div>`,
          `task-reminder/${task.id}-${Date.parse(task.reminder_at!)}`,
          [
            { name: "category", value: "task-reminder" },
            { name: "task_id", value: task.id }
          ]
        );
      } catch (cause) {
        console.error(JSON.stringify({ message: "reminder email failed", taskId: task.id, error: cause instanceof Error ? cause.message : String(cause) }));
        continue;
      }
    }
    await env.DB.prepare("UPDATE tasks SET reminder_sent_at = ?, updated_at = ? WHERE id = ?").bind(now, now, task.id).run();
  }
  console.log(JSON.stringify({ message: "reminders processed", count: due.results.length }));
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/auth/status" && request.method === "GET") {
    return json({ authenticated: await isAuthenticated(request, env), configured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET) });
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return error("服务尚未配置登录密钥", 503);
    const body = await readBody(request);
    const valid = await secureEqual(textValue(body.password, 500), env.APP_PASSWORD);
    if (!valid) return error("密码不正确", 401);
    const token = await createSession(env.SESSION_SECRET);
    return json({ ok: true }, 200, {
      "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_AGE_SECONDS}`
    });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  if (!(await isAuthenticated(request, env))) return error("请先登录", 401);
  if (!["GET", "HEAD"].includes(request.method) && !assertSameOrigin(request)) return error("请求来源无效", 403);

  if (path === "/api/bootstrap" && request.method === "GET") return bootstrap(env);
  if (path === "/api/backup" && request.method === "GET") {
    const backup = await exportBackup(env.DB);
    try { validateBackup(backup); } catch (cause) { return error(cause instanceof Error ? cause.message : "无法生成备份"); }
    const content = JSON.stringify(backup);
    if (new TextEncoder().encode(content).byteLength > MAX_BACKUP_BYTES) return error("当前数据超过 2 MB 备份上限");
    return new Response(content, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="morrow-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
  }
  if (["/api/backup/validate", "/api/backup/restore"].includes(path) && request.method === "POST") {
    let backup;
    try { backup = validateBackup(await readBackup(request)); }
    catch (cause) { return error(cause instanceof Error ? cause.message : "备份无效"); }
    if (path.endsWith("/restore")) {
      if (request.headers.get("X-Morrow-Restore") !== "replace") return error("请先确认替换当前数据");
      await restoreBackup(env.DB, backup);
    }
    return json({ ok: true, exportedAt: backup.exportedAt, ...backupCounts(backup) });
  }
  if (path === "/api/projects" && request.method === "POST") return createProject(request, env);
  if (path.startsWith("/api/projects/")) {
    const id = decodeURIComponent(path.slice("/api/projects/".length));
    if (request.method === "PUT") return updateProject(request, env, id);
    if (request.method === "DELETE") return deleteProject(env, id);
  }
  if (path === "/api/tasks" && request.method === "POST") return createTask(request, env);
  if (path.startsWith("/api/tasks/")) {
    const id = decodeURIComponent(path.slice("/api/tasks/".length));
    if (request.method === "PUT") return updateTask(request, env, id);
    if (request.method === "DELETE") return deleteTask(env, id);
  }
  if (path === "/api/notifications/read" && request.method === "POST") {
    await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").bind(isoNow()).run();
    return json({ ok: true });
  }
  if (path === "/api/settings" && request.method === "PUT") return updateSettings(request, env);
  if (path === "/api/settings/test-email" && request.method === "POST") return testEmail(env);
  return error("接口不存在", 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        if (!env.DB) return error("请在 Cloudflare Worker 的 Bindings 页面添加名为 DB 的 D1 数据库，然后重新运行部署", 503);
        return await api(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (cause) {
      console.error(JSON.stringify({ message: "request failed", path: new URL(request.url).pathname, error: cause instanceof Error ? cause.message : String(cause) }));
      if (cause instanceof Error && /no such table:/i.test(cause.message)) {
        return error("数据库尚未初始化。请在绑定 D1 后重新运行 Cloudflare 最新构建，完成数据库初始化", 503);
      }
      return error("服务器暂时无法处理请求", 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    if (env.DB && env.APP_PASSWORD && env.SESSION_SECRET) ctx.waitUntil(processReminders(env));
  }
} satisfies ExportedHandler<Env>;
