export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
type Row = Record<string, string | number | null>;
const tables = {
  projects: { id: "s", name: "s", description: "s", color: "s", position: "i", created_at: "s", updated_at: "s" },
  tasks: { id: "s", project_id: "n", parent_id: "n", title: "s", description: "s", status: "s", priority: "i", start_at: "n", due_at: "n", reminder_at: "n", reminder_sent_at: "n", recurrence_rule: "n", completed_at: "n", position: "i", created_at: "s", updated_at: "s" },
  tags: { id: "s", name: "s", color: "s", created_at: "s" },
  task_tags: { task_id: "s", tag_id: "s" },
  notifications: { id: "s", task_id: "n", title: "s", body: "s", read_at: "n", created_at: "s" },
  settings: { key: "s", value: "s", updated_at: "s" }
} as const;
type Table = keyof typeof tables;
export type Backup = { app: "morrow"; version: 1; exportedAt: string; data: Record<Table, Row[]> };

export function validateBackup(value: unknown): Backup {
  const fail = (): never => { throw new Error("备份格式无效、数据不完整或含有重复记录，请选择 Morrow 导出的完整备份"); };
  if (!value || typeof value !== "object") return fail();
  const input = value as Backup;
  if (input.app !== "morrow" || input.version !== 1 || typeof input.exportedAt !== "string" || !Number.isFinite(Date.parse(input.exportedAt)) || !input.data) return fail();
  let total = 0;
  for (const [table, schema] of Object.entries(tables)) {
    const rows = input.data[table as Table];
    if (!Array.isArray(rows)) return fail();
    total += rows.length;
    if (total > 5000) throw new Error("备份超过当前支持的 5000 条记录上限");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Object.keys(row).length !== Object.keys(schema).length) return fail();
      for (const [column, type] of Object.entries(schema)) {
        const field = row[column];
        if (type === "i" ? !Number.isSafeInteger(field) : !(typeof field === "string" || (type === "n" && field === null))) return fail();
        if (typeof field === "string" && field.length > 20000) return fail();
        if (column.endsWith("_at") && field !== null && !Number.isFinite(Date.parse(String(field)))) return fail();
      }
      const key = table === "task_tags" ? JSON.stringify([row.task_id, row.tag_id]) : String(row.id ?? row.key);
      if (!key || seen.has(key) || ("id" in row && !row.id)) return fail();
      seen.add(key);
    }
  }
  const projects = new Set(input.data.projects.map((row) => row.id));
  const tasks = new Map(input.data.tasks.map((row) => [row.id, row]));
  const tags = new Set(input.data.tags.map((row) => row.id));
  if (!projects.has("inbox")) return fail();
  for (const row of tasks.values()) {
    if (!["open", "done"].includes(String(row.status)) || Number(row.priority) < 0 || Number(row.priority) > 4) return fail();
    if (row.recurrence_rule !== null && !["daily", "weekly", "monthly", "yearly"].includes(String(row.recurrence_rule))) return fail();
    if (row.project_id !== null && !projects.has(row.project_id)) return fail();
    const visited = new Set([row.id]);
    let parent = row.parent_id;
    while (parent !== null) {
      if (visited.has(parent) || !tasks.has(parent)) return fail();
      visited.add(parent);
      parent = tasks.get(parent)!.parent_id;
    }
  }
  for (const row of input.data.task_tags) if (!tasks.has(row.task_id) || !tags.has(row.tag_id)) return fail();
  for (const row of input.data.notifications) if (row.task_id !== null && !tasks.has(row.task_id)) return fail();
  const settings = new Map(input.data.settings.map((row) => [row.key, row.value]));
  if (["timezone", "email_enabled", "email_to", "email_from"].some((key) => !settings.has(key)) || !["true", "false"].includes(String(settings.get("email_enabled")))) return fail();
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: String(settings.get("timezone")) }); } catch { return fail(); }
  return input;
}

export function backupCounts(backup: Backup) {
  return { projects: backup.data.projects.length, tasks: backup.data.tasks.length, tags: backup.data.tags.length, notifications: backup.data.notifications.length };
}

export async function exportBackup(db: D1Database): Promise<Backup> {
  const names = Object.keys(tables) as Table[];
  const result = await db.batch<Row>(names.map((table) => db.prepare(`SELECT ${Object.keys(tables[table]).join(", ")} FROM ${table}`)));
  return { app: "morrow", version: 1, exportedAt: new Date().toISOString(), data: Object.fromEntries(names.map((name, i) => [name, result[i].results])) as Backup["data"] };
}

export async function restoreBackup(db: D1Database, backup: Backup): Promise<void> {
  const statements = ["task_undo", "task_tags", "notifications", "tasks", "tags", "projects", "settings"].map((table) => db.prepare(`DELETE FROM ${table}`));
  for (const table of Object.keys(tables) as Table[]) {
    const columns = Object.keys(tables[table]);
    // One INSERT per table keeps restoration within the Free plan's query
    // limit. SQLite checks parent references at the end of this statement,
    // so a child may appear before its parent in the JSON array.
    statements.push(db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map((key) => `json_extract(value, '$.${key}')`).join(", ")} FROM json_each(?)`).bind(JSON.stringify(backup.data[table])));
  }
  // D1 batch is transactional: any constraint failure rolls everything back.
  await db.batch(statements);
}

export async function readBackup(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("请选择备份文件");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BACKUP_BYTES) { await reader.cancel(); throw new Error("备份文件不能超过 2 MB"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("备份文件不是有效的 JSON 文件"); }
}
