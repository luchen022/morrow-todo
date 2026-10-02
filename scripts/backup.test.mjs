import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { exportBackup, validateBackup, restoreBackup, readBackup, MAX_BACKUP_BYTES } from "../worker/backup.ts";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const adapter = {
    prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; return this; } }; },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, values }) => {
          const prepared = sqlite.prepare(sql);
          return { results: /^SELECT/.test(sql) ? prepared.all(...values).map((row) => ({ ...row })) : (prepared.run(...values), []) };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  };
  return { sqlite, adapter };
}

test("round trip preserves children, tags, reminders, notifications and settings", async () => {
  const { sqlite, adapter } = database();
  sqlite.exec(`INSERT INTO tasks (id,project_id,title,reminder_at,reminder_sent_at,created_at,updated_at) VALUES ('parent','inbox','父任务','2026-10-02T12:00:00Z','2026-10-02T12:00:01Z',datetime('now'),datetime('now'));
    INSERT INTO tasks (id,parent_id,title,created_at,updated_at) VALUES ('child','parent','子任务',datetime('now'),datetime('now'));
    INSERT INTO tags VALUES ('tag','工作','#123456',datetime('now'));
    INSERT INTO task_tags VALUES ('child','tag');
    INSERT INTO notifications VALUES ('notice','parent','提醒','内容',NULL,datetime('now'));
    UPDATE settings SET value='true' WHERE key='email_enabled';`);
  const backup = validateBackup(await exportBackup(adapter));
  backup.data.tasks.reverse(); // Child appears before parent in the file.
  const other = database();
  await restoreBackup(other.adapter, backup);
  const restored = await exportBackup(other.adapter);
  for (const table of Object.keys(backup.data)) {
    const sorted = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(sorted(restored.data[table]), sorted(backup.data[table]));
  }
  sqlite.close(); other.sqlite.close();
});

test("failed restore rolls back deletion of existing data", async () => {
  const { sqlite, adapter } = database();
  const before = await exportBackup(adapter);
  const backup = structuredClone(before);
  backup.data.tags = [
    { id: "a", name: "Work", color: "#123456", created_at: "2026-10-02T12:00:00Z" },
    { id: "b", name: "work", color: "#123456", created_at: "2026-10-02T12:00:00Z" }
  ];
  await assert.rejects(restoreBackup(adapter, validateBackup(backup)), /UNIQUE/);
  assert.deepEqual((await exportBackup(adapter)).data, before.data);
  sqlite.close();
});

test("invalid references, duplicate IDs, cycles and unsupported versions are rejected", async () => {
  const { sqlite, adapter } = database();
  const original = await exportBackup(adapter);
  const task = { id: "a", project_id: "inbox", parent_id: null, title: "任务", description: "", status: "open", priority: 0, start_at: null, due_at: null, reminder_at: null, reminder_sent_at: null, recurrence_rule: null, completed_at: null, position: 0, created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z" };
  for (const mutate of [
    (backup) => { backup.version = 99; },
    (backup) => { backup.data.projects.push(backup.data.projects[0]); },
    (backup) => { backup.data.tasks = [{ ...task, project_id: "missing" }]; },
    (backup) => { backup.data.tasks = [{ ...task, parent_id: "a" }]; },
    (backup) => { backup.data.tasks = [{ ...task, due_at: "bad-date" }]; },
    (backup) => { delete backup.data.settings; }
  ]) {
    const backup = structuredClone(original); mutate(backup);
    assert.throws(() => validateBackup(backup));
  }
  sqlite.close();
});

test("malformed JSON and oversized uploads are rejected", async () => {
  await assert.rejects(readBackup(new Request("https://example.test", { method: "POST", body: "invalid" })), /JSON/);
  await assert.rejects(readBackup(new Request("https://example.test", { method: "POST", body: "x".repeat(MAX_BACKUP_BYTES + 1) })), /2 MB/);
});
