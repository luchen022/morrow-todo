import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { deleteTaskWithUndo, toggleTaskWithUndo, undoTaskAction } from "../worker/undo.ts";

function database() {
  const sql = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_task_undo.sql"]) sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const db = {
    prepare(query) { return { query, values: [], bind(...values) { this.values = values; return this; }, async first() { return sql.prepare(this.query).get(...this.values) ?? null; } }; },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const result = statements.map(({ query, values }) => {
          const prepared = sql.prepare(query);
          return { results: prepared.columns().length ? prepared.all(...values) : (prepared.run(...values), []) };
        });
        sql.exec("COMMIT"); return result;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    }
  };
  sql.exec(`INSERT INTO tasks(id,project_id,title,due_at,recurrence_rule,created_at,updated_at) VALUES ('parent','inbox','父任务','2026-10-02T12:00:00Z','daily',datetime('now'),datetime('now'));
    INSERT INTO tasks(id,parent_id,title,created_at,updated_at) VALUES ('child','parent','子任务',datetime('now'),datetime('now'));
    INSERT INTO tags VALUES ('tag','工作','#123456',datetime('now'));
    INSERT INTO task_tags VALUES ('child','tag');
    INSERT INTO notifications VALUES ('notice','child','提醒','内容',NULL,datetime('now'));`);
  return { sql, db };
}

test("deleted subtree, tags and notifications are restored exactly once", async () => {
  const { sql, db } = database();
  const before = sql.prepare("SELECT * FROM tasks ORDER BY id").all();
  const action = await deleteTaskWithUndo(db, "parent");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM tasks").get().n,0);
  await undoTaskAction(db,action.undoToken);
  assert.deepEqual(sql.prepare("SELECT * FROM tasks ORDER BY id").all(),before);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM task_tags").get().n,1);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM notifications").get().n,1);
  await assert.rejects(undoTaskAction(db,action.undoToken), /已过/);
  sql.close();
});

test("undo completion removes the generated recurrence without creating another", async () => {
  const { sql, db } = database();
  const before = sql.prepare("SELECT * FROM tasks WHERE id='parent'").get();
  const action = await toggleTaskWithUndo(db,"parent");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM tasks").get().n,3);
  assert.equal(sql.prepare("SELECT status FROM tasks WHERE id='parent'").get().status,"done");
  await undoTaskAction(db,action.undoToken);
  assert.deepEqual(sql.prepare("SELECT * FROM tasks WHERE id='parent'").get(),before);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM tasks").get().n,2);
  sql.close();
});

test("undo reopening restores completion state", async () => {
  const { sql, db } = database();
  sql.exec("UPDATE tasks SET status='done',completed_at='2026-10-02T12:00:00Z' WHERE id='child'");
  const action=await toggleTaskWithUndo(db,'child');
  await undoTaskAction(db,action.undoToken);
  assert.equal(sql.prepare("SELECT completed_at FROM tasks WHERE id='child'").get().completed_at,'2026-10-02T12:00:00Z');
  sql.close();
});

test("new edits to a recurrence block undo and preserve all current data", async () => {
  const { sql, db } = database();
  const action=await toggleTaskWithUndo(db,'parent');
  sql.exec("UPDATE tasks SET title='新的编辑',updated_at='2099-01-01T00:00:00Z' WHERE id NOT IN ('parent','child')");
  await assert.rejects(undoTaskAction(db,action.undoToken), /发生变化/);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM tasks").get().n,3);
  assert.equal(sql.prepare("SELECT status FROM tasks WHERE id='parent'").get().status,'done');
  sql.close();
});

test("deleted project blocks task restoration without partial writes", async () => {
  const { sql, db } = database();
  const action=await deleteTaskWithUndo(db,'parent');
  sql.exec("DELETE FROM projects WHERE id='inbox'");
  await assert.rejects(undoTaskAction(db,action.undoToken), /发生变化/);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM tasks").get().n,0);
  sql.close();
});

test("expired token cannot restore a deleted task", async () => {
  const { sql, db } = database();
  const action=await deleteTaskWithUndo(db,'child');
  sql.prepare('UPDATE task_undo SET expires_at=0 WHERE token=?').run(action.undoToken);
  await assert.rejects(undoTaskAction(db,action.undoToken), /已过/);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM tasks WHERE id='child'").get().n,0);
  sql.close();
});
