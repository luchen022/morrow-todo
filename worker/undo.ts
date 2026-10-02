type Row = Record<string, string | number | null>;
const taskColumns = ["id", "project_id", "parent_id", "title", "description", "status", "priority", "start_at", "due_at", "reminder_at", "reminder_sent_at", "recurrence_rule", "completed_at", "position", "created_at", "updated_at"];
type Snapshot = { tasks: Row[]; links: Row[]; notices: Row[]; expected?: Row; successor?: Row };
const descendants = "WITH RECURSIVE subtree(id) AS (SELECT id FROM tasks WHERE id = ? UNION SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id)";

async function saveAction(db: D1Database, kind: string, snapshot: Snapshot, changes: D1PreparedStatement[]) {
  const undoToken = crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;
  const payload = JSON.stringify(snapshot);
  if (new TextEncoder().encode(payload).byteLength > 1_500_000) throw new Error("任务包含的数据过多，暂时无法安全撤销此次操作");
  await db.batch([
    db.prepare("DELETE FROM task_undo WHERE expires_at < ?").bind(Date.now()),
    db.prepare("INSERT INTO task_undo (token, kind, payload, expires_at) VALUES (?, ?, ?, ?)").bind(undoToken, kind, payload, expiresAt),
    ...changes
  ]);
  return { undoToken, expiresAt };
}

export async function deleteTaskWithUndo(db: D1Database, id: string) {
  const [tasks, links, notices] = await db.batch<Row>([
    db.prepare(`${descendants} SELECT t.* FROM tasks t JOIN subtree s ON t.id = s.id`).bind(id),
    db.prepare(`${descendants} SELECT * FROM task_tags WHERE task_id IN (SELECT id FROM subtree)`).bind(id),
    db.prepare(`${descendants} SELECT * FROM notifications WHERE task_id IN (SELECT id FROM subtree)`).bind(id)
  ]);
  if (!tasks.results.length) throw new Error("任务不存在");
  return saveAction(db, "delete", { tasks: tasks.results, links: links.results, notices: notices.results }, [db.prepare("DELETE FROM tasks WHERE id = ?").bind(id)]);
}

function nextDate(value: Row[string], rule: string) {
  if (!value) return null;
  const date = new Date(String(value));
  if (rule === "daily") date.setUTCDate(date.getUTCDate() + 1);
  if (rule === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  if (rule === "monthly") date.setUTCMonth(date.getUTCMonth() + 1);
  if (rule === "yearly") date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

export async function toggleTaskWithUndo(db: D1Database, id: string) {
  const existing = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Row>();
  if (!existing) throw new Error("任务不存在");
  const now = new Date(Math.max(Date.now(), Date.parse(String(existing.updated_at)) + 1)).toISOString();
  const done = existing.status !== "done";
  const expected = { ...existing, status: done ? "done" : "open", completed_at: done ? now : null, updated_at: now };
  const changes = [db.prepare("UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?").bind(expected.status, expected.completed_at, now, id)];
  let successor: Row | undefined;
  if (done && existing.recurrence_rule && existing.due_at) {
    successor = { ...existing, id: crypto.randomUUID(), status: "open", completed_at: null, reminder_sent_at: null, created_at: now, updated_at: now,
      due_at: nextDate(existing.due_at, String(existing.recurrence_rule)), start_at: nextDate(existing.start_at, String(existing.recurrence_rule)), reminder_at: nextDate(existing.reminder_at, String(existing.recurrence_rule)) };
    changes.push(db.prepare(`INSERT INTO tasks (${taskColumns.join(",")}) VALUES (${taskColumns.map(() => "?").join(",")})`).bind(...taskColumns.map((key) => successor![key])));
    changes.push(db.prepare("INSERT INTO task_tags (task_id, tag_id) SELECT ?, tag_id FROM task_tags WHERE task_id = ?").bind(successor.id, id));
  }
  return { ...(await saveAction(db, "status", { tasks: [existing], links: [], notices: [], expected, successor }, changes)), status: expected.status };
}

export async function undoTaskAction(db: D1Database, token: string) {
  const action = await db.prepare("SELECT * FROM task_undo WHERE token = ? AND expires_at >= ?").bind(token, Date.now()).first<{ kind: string; payload: string }>();
  if (!action) throw new Error("撤销时间已过，或此操作已经撤销");
  const snapshot = JSON.parse(action.payload) as Snapshot;
  const active = "EXISTS (SELECT 1 FROM task_undo WHERE token = ? AND ready = 1)";
  const statements: D1PreparedStatement[] = [];
  const ids = JSON.stringify(snapshot.tasks.map((row) => row.id));
  if (action.kind === "delete") {
    // Validate against current data inside the same transaction as restoration.
    const projects = JSON.stringify(snapshot.tasks.map((row) => row.project_id).filter(Boolean));
    const parents = JSON.stringify(snapshot.tasks.map((row) => row.parent_id).filter((id) => id && !snapshot.tasks.some((row) => row.id === id)));
    const tags = JSON.stringify(snapshot.links.map((row) => row.tag_id));
    const notices = JSON.stringify(snapshot.notices.map((row) => row.id));
    statements.push(db.prepare(`UPDATE task_undo SET ready = 1 WHERE token = ? AND expires_at >= ?
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE id IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value NOT IN (SELECT id FROM projects))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value NOT IN (SELECT id FROM tasks))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value NOT IN (SELECT id FROM tags))
      AND NOT EXISTS (SELECT 1 FROM notifications WHERE id IN (SELECT value FROM json_each(?)))`).bind(token, Date.now(), ids, projects, parents, tags, notices));
    for (const [table, rows, columns] of [
      ["tasks", snapshot.tasks, taskColumns],
      ["task_tags", snapshot.links, ["task_id", "tag_id"]],
      ["notifications", snapshot.notices, ["id", "task_id", "title", "body", "read_at", "created_at"]]
    ] as [string, Row[], string[]][]) {
      statements.push(db.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map((key) => `json_extract(value, '$.${key}')`).join(",")} FROM json_each(?) WHERE ${active}`).bind(JSON.stringify(rows), token));
    }
  } else {
    const old = snapshot.tasks[0];
    const successor = snapshot.successor;
    statements.push(db.prepare(`UPDATE task_undo SET ready = 1 WHERE token = ? AND expires_at >= ?
      AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?)
      ${successor ? "AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?) AND NOT EXISTS (SELECT 1 FROM tasks WHERE parent_id = ?)" : ""}`).bind(token, Date.now(), old.id, snapshot.expected!.updated_at, ...(successor ? [successor.id, successor.updated_at, successor.id] : [])));
    if (successor) statements.push(db.prepare(`DELETE FROM tasks WHERE id = ? AND ${active}`).bind(successor.id, token));
    statements.push(db.prepare(`UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND ${active}`).bind(old.status, old.completed_at, old.updated_at, old.id, token));
  }
  statements.push(db.prepare("DELETE FROM task_undo WHERE token = ? AND ready = 1 RETURNING token").bind(token));
  const result = await db.batch(statements);
  if (!result.at(-1)!.results.length) throw new Error("相关任务已发生变化，无法撤销；当前数据已保留");
}
