import type { SQLQueryBindings } from "bun:sqlite";

export interface SchemaDatabase {
  all<T>(sql: string, params: SQLQueryBindings[]): T[];
  exec(sql: string): void;
  run(sql: string, params: SQLQueryBindings[]): unknown;
}

export function configureDatabase(db: Pick<SchemaDatabase, "exec">): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
}

export function migrateDatabase(db: SchemaDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'available',
      current_task_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (workspace, id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'channel')),
      thread_id TEXT NOT NULL,
      reply_to_message_id TEXT,
      sender_id TEXT NOT NULL,
      recipient_id TEXT,
      channel TEXT,
      body TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      CHECK (
        (recipient_id IS NOT NULL AND channel IS NULL)
        OR (recipient_id IS NULL AND channel IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (message_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      creator_id TEXT NOT NULL,
      assignee_id TEXT,
      channel TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'blocked', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      parent_task_id TEXT,
      blocked_reason TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'blocked', 'cancelled')),
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('message', 'task', 'note')),
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('file', 'url', 'diff', 'screenshot', 'log', 'command', 'other')),
      label TEXT,
      path TEXT,
      url TEXT,
      line INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT 'default',
      channel TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      creator_id TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS locks (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT 'default',
      resource TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      purpose TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace, resource)
    );

    CREATE TABLE IF NOT EXISTS access_keys (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'default',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "agents", "workspace", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "agents", "status", "TEXT NOT NULL DEFAULT 'available'");
  ensureColumn(db, "agents", "current_task_id", "TEXT");
  ensureColumn(db, "messages", "workspace", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "messages", "thread_id", "TEXT");
  ensureColumn(db, "messages", "reply_to_message_id", "TEXT");
  ensureColumn(db, "tasks", "workspace", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "tasks", "priority", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "due_at", "TEXT");
  ensureColumn(db, "tasks", "parent_task_id", "TEXT");
  ensureColumn(db, "tasks", "blocked_reason", "TEXT");
  migrateAgentsTable(db);
  migrateTaskDependenciesTable(db);
  db.run(`UPDATE messages SET thread_id = id WHERE thread_id IS NULL OR thread_id = ''`, []);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_workspace_seen ON agents(workspace, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_messages_workspace_thread_created ON messages(workspace, thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages(recipient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(workspace, channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_updated ON tasks(workspace, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_updated ON tasks(assignee_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_notes_workspace_channel_updated ON notes(workspace, channel, updated_at);
    CREATE INDEX IF NOT EXISTS idx_locks_workspace_resource ON locks(workspace, resource);
    CREATE INDEX IF NOT EXISTS idx_access_keys_agent_workspace ON access_keys(agent_id, workspace);
  `);
}

function ensureColumn(
  db: Pick<SchemaDatabase, "all" | "exec">,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`, []);
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateAgentsTable(db: SchemaDatabase): void {
  const columns = db.all<{ name: string; pk: number }>(`PRAGMA table_info(agents)`, []);
  const idPk = columns.find((item) => item.name === "id")?.pk ?? 0;
  const workspacePk = columns.find((item) => item.name === "workspace")?.pk ?? 0;
  if (workspacePk === 1 && idPk === 2) {
    return;
  }

  db.exec(`
    CREATE TABLE agents_workspace_migration (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'available',
      current_task_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (workspace, id)
    );

    INSERT OR REPLACE INTO agents_workspace_migration
      (id, name, workspace, status, current_task_id, metadata, created_at, updated_at, last_seen_at)
    SELECT
      id,
      name,
      COALESCE(NULLIF(workspace, ''), 'default'),
      COALESCE(NULLIF(status, ''), 'available'),
      current_task_id,
      metadata,
      created_at,
      updated_at,
      last_seen_at
    FROM agents;

    DROP TABLE agents;
    ALTER TABLE agents_workspace_migration RENAME TO agents;
  `);
}

function migrateTaskDependenciesTable(db: SchemaDatabase): void {
  const foreignKeys = db.all<{ from: string; table: string }>(
    `PRAGMA foreign_key_list(task_dependencies)`,
    [],
  );
  const hasTaskIdKey = foreignKeys.some(
    (item) => item.from === "task_id" && item.table === "tasks",
  );
  const hasDependencyKey = foreignKeys.some(
    (item) => item.from === "depends_on_task_id" && item.table === "tasks",
  );
  if (hasTaskIdKey && hasDependencyKey) {
    return;
  }

  db.exec(`
    CREATE TABLE task_dependencies_migration (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id)
    );

    INSERT OR IGNORE INTO task_dependencies_migration (task_id, depends_on_task_id)
    SELECT d.task_id, d.depends_on_task_id
    FROM task_dependencies d
    JOIN tasks task ON task.id = d.task_id
    JOIN tasks dependency ON dependency.id = d.depends_on_task_id;

    DROP TABLE task_dependencies;
    ALTER TABLE task_dependencies_migration RENAME TO task_dependencies;
  `);
}
