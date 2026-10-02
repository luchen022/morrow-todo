CREATE TABLE task_undo (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('delete', 'status')),
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_task_undo_expiry ON task_undo(expires_at);
