import { Database } from "bun:sqlite";
import { join, basename } from "path";
import { mkdirSync, existsSync } from "fs";
import { nanoid } from "nanoid";
import { resolveProjectPath, validateGitRepo } from "../utils/git";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS threads (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    agent       TEXT NOT NULL,
    effort_level TEXT,
    repo_path   TEXT NOT NULL,
    worktree    TEXT,
    branch      TEXT,
    pr_url      TEXT,
    pid         INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending',
    archived_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES threads(id),
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    tool_name   TEXT,
    tool_input  TEXT,
    tool_output TEXT,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq)`,
  `CREATE TABLE IF NOT EXISTS agent_configs (
    name     TEXT PRIMARY KEY,
    command  TEXT NOT NULL,
    args     TEXT NOT NULL DEFAULT '[]',
    detected INTEGER NOT NULL DEFAULT 0,
    version  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    added_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS attention_required (
    id                 TEXT PRIMARY KEY,
    thread_id          TEXT NOT NULL REFERENCES threads(id),
    kind               TEXT NOT NULL,
    prompt             TEXT NOT NULL,
    options            TEXT,
    metadata           TEXT,
    continuation_token TEXT,
    resolved_at        TEXT,
    resolution         TEXT,
    expires_at         TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attention_pending
    ON attention_required(thread_id, resolved_at) WHERE resolved_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         TEXT PRIMARY KEY,
    endpoint   TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth   TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// Column migration — safe to run multiple times
const COLUMN_MIGRATIONS = [
  {
    table: "threads",
    column: "effort_level",
    sql: `ALTER TABLE threads ADD COLUMN effort_level TEXT`,
  },
  {
    table: "threads",
    column: "project_id",
    sql: `ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects(id)`,
  },
  {
    table: "threads",
    column: "error_message",
    sql: `ALTER TABLE threads ADD COLUMN error_message TEXT`,
  },
  {
    table: "threads",
    column: "session_id",
    sql: `ALTER TABLE threads ADD COLUMN session_id TEXT`,
  },
  {
    table: "push_subscriptions",
    column: "origin",
    sql: `ALTER TABLE push_subscriptions ADD COLUMN origin TEXT DEFAULT ''`,
  },
  {
    table: "threads",
    column: "last_interacted_at",
    // SQLite rejects expression defaults (datetime('now')) in ALTER TABLE on non-empty tables.
    // Use empty string as placeholder, then backfill from created_at to preserve relative order.
    sql: `ALTER TABLE threads ADD COLUMN last_interacted_at TEXT NOT NULL DEFAULT ''`,
    postMigrate: `UPDATE threads SET last_interacted_at = created_at`,
  },
  {
    table: "threads",
    column: "pr_status",
    sql: `ALTER TABLE threads ADD COLUMN pr_status TEXT`,
  },
  {
    table: "threads",
    column: "pr_number",
    sql: `ALTER TABLE threads ADD COLUMN pr_number INTEGER`,
  },
  {
    table: "threads",
    column: "pr_status_checked_at",
    sql: `ALTER TABLE threads ADD COLUMN pr_status_checked_at TEXT`,
  },
];

const INDEX_MIGRATIONS = [
  `CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id)`,
];

export function createDb(dbPath?: string): Database {
  const dir = dbPath
    ? dbPath
    : join(process.env.HOME || "~", ".orchestra");
  mkdirSync(dir, { recursive: true });

  const db = new Database(join(dir, "orchestra.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }

  // Run column migrations (safe if column already exists)
  for (const { table, column, sql, postMigrate } of COLUMN_MIGRATIONS) {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(sql);
      if (postMigrate) db.exec(postMigrate);
    }
  }

  for (const sql of INDEX_MIGRATIONS) {
    db.exec(sql);
  }

  // Backfill: auto-create projects for orphaned threads
  backfillProjects(db);

  return db;
}

function backfillProjects(db: Database): void {
  const orphaned = db
    .query("SELECT DISTINCT repo_path FROM threads WHERE project_id IS NULL AND repo_path IS NOT NULL AND archived_at IS NULL")
    .all() as Array<{ repo_path: string }>;

  if (orphaned.length === 0) return;

  for (const { repo_path } of orphaned) {
    // Normalize the path
    let normalizedPath: string;
    try {
      normalizedPath = resolveProjectPath(repo_path);
    } catch {
      // Path no longer exists — skip backfill for these threads
      console.log(`Backfill: skipping missing path ${repo_path}`);
      continue;
    }

    // Check if a project already exists for this normalized path
    const existing = db
      .query("SELECT id FROM projects WHERE path = ?")
      .get(normalizedPath) as { id: string } | null;

    let projectId: string;
    if (existing) {
      projectId = existing.id;
    } else {
      projectId = nanoid(12);
      const name = basename(normalizedPath);
      db.query(
        "INSERT INTO projects (id, name, path) VALUES (?, ?, ?)",
      ).run(projectId, name, normalizedPath);
      console.log(`Backfill: created project "${name}" for ${normalizedPath}`);
    }

    // Backfill all threads with this repo_path
    db.query(
      "UPDATE threads SET project_id = ? WHERE repo_path = ? AND project_id IS NULL AND archived_at IS NULL",
    ).run(projectId, repo_path);
  }
}

// ── Helpers ─────────────────────────────────────────────

export type DB = Database;

// ── Project helpers ─────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  updated_at: string;
  added_at: string;
}

export function validateAndInsertProject(
  db: DB,
  rawPath: string,
  name?: string,
): ProjectRow {
  const resolvedPath = resolveProjectPath(rawPath);
  validateGitRepo(resolvedPath);

  const id = nanoid(12);
  const projectName = name || basename(resolvedPath);

  db.query(
    "INSERT INTO projects (id, name, path) VALUES (?, ?, ?)",
  ).run(id, projectName, resolvedPath);

  return getProject(db, id)!;
}

export function listProjects(db: DB): ProjectRow[] {
  return db
    .query("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as ProjectRow[];
}

export function getProject(db: DB, id: string): ProjectRow | null {
  return db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null;
}

export function deleteProject(db: DB, id: string): void {
  // Archive associated threads and null out FK before deleting project
  db.query(
    "UPDATE threads SET archived_at = datetime('now'), project_id = NULL WHERE project_id = ? AND archived_at IS NULL",
  ).run(id);
  db.query(
    "UPDATE threads SET project_id = NULL WHERE project_id = ?",
  ).run(id);
  db.query("DELETE FROM projects WHERE id = ?").run(id);
}

// Fix 7: Column allowlists prevent SQL injection via dynamic column names
const PROJECT_COLUMNS = new Set(["name"]);
const THREAD_COLUMNS = new Set([
  "title", "status", "worktree", "branch", "pid",
  "error_message", "pr_url", "archived_at", "session_id", "effort_level",
]);

export function updateProject(db: DB, id: string, fields: Partial<ProjectRow>): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (key === "id" || !PROJECT_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(val as string | number | null);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(values as [string, ...string[]]),
  );
}

export function touchProjectUpdatedAt(db: DB, projectId: string): void {
  db.query("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
}

/** Update last_interacted_at — call only when the user sends a message */
export function touchThreadInteraction(db: DB, threadId: string): void {
  db.query("UPDATE threads SET last_interacted_at = datetime('now') WHERE id = ?").run(threadId);
}

export function getProjectThreadCounts(
  db: DB,
  projectId: string,
): { total: number; active: number; outstandingPrs: number } {
  const total = db
    .query("SELECT COUNT(*) as count FROM threads WHERE project_id = ? AND archived_at IS NULL")
    .get(projectId) as { count: number };
  const active = db
    .query(
      "SELECT COUNT(*) as count FROM threads WHERE project_id = ? AND status IN ('running', 'pending', 'waiting') AND archived_at IS NULL",
    )
    .get(projectId) as { count: number };
  const outstandingPrs = db
    .query(
      `SELECT COUNT(*) as count
       FROM threads
       WHERE project_id = ?
         AND archived_at IS NULL
         AND pr_url IS NOT NULL
         AND (pr_status IS NULL OR pr_status IN ('open', 'draft'))`,
    )
    .get(projectId) as { count: number };
  return {
    total: total.count,
    active: active.count,
    outstandingPrs: outstandingPrs.count,
  };
}

export function listOutstandingPrThreads(
  db: DB,
  projectId: string,
): ThreadRow[] {
  return db
    .query(
      `SELECT *
       FROM threads
       WHERE project_id = ?
         AND archived_at IS NULL
         AND pr_url IS NOT NULL
         AND (pr_status IS NULL OR pr_status IN ('open', 'draft'))
       ORDER BY
         CASE pr_status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
         COALESCE(pr_number, 2147483647),
         last_interacted_at DESC`,
    )
    .all(projectId) as ThreadRow[];
}

export function projectRowToApi(row: ProjectRow): import("shared").Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    updatedAt: row.updated_at,
    addedAt: row.added_at,
  };
}

export function getThread(db: DB, id: string) {
  return db.query("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
}

export function listThreads(db: DB) {
  return db
    .query("SELECT * FROM threads WHERE archived_at IS NULL ORDER BY last_interacted_at DESC")
    .all() as ThreadRow[];
}

export function getMessages(db: DB, threadId: string, afterSeq = 0) {
  return db
    .query("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC")
    .all(threadId, afterSeq) as MessageRow[];
}

export function insertMessage(db: DB, msg: Omit<MessageRow, "seq">): number {
  const result = db.query(
    `INSERT INTO messages (id, thread_id, seq, role, content, tool_name, tool_input, tool_output, metadata, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ?), ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    msg.id,
    msg.thread_id,
    msg.thread_id, // for the subquery
    msg.role,
    msg.content,
    msg.tool_name,
    msg.tool_input,
    msg.tool_output,
    msg.metadata,
  );
  // Return the assigned seq
  const row = db
    .query("SELECT seq FROM messages WHERE id = ?")
    .get(msg.id) as { seq: number };
  return row.seq;
}

export function updateThread(db: DB, id: string, fields: Partial<ThreadRow>) {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (key === "id" || !THREAD_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(val as string | number | null);
  }
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.query(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(values as [string, ...string[]]),
  );
}

/**
 * Update thread fields WITHOUT bumping updated_at.
 * Use for background housekeeping (e.g., PR status refresh) that shouldn't
 * affect sidebar sort order.
 */
export function updateThreadSilent(db: DB, id: string, fields: Partial<ThreadRow>) {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (key === "id") continue;
    sets.push(`${key} = ?`);
    values.push(val as string | number | null);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(values as [string, ...string[]]),
  );
}

// ── Attention helpers ────────────────────────────────────

export interface AttentionRow {
  id: string;
  thread_id: string;
  kind: string;
  prompt: string;
  options: string | null;
  metadata: string | null;
  continuation_token: string | null;
  resolved_at: string | null;
  resolution: string | null;
  expires_at: string | null;
  created_at: string;
}

const DEFAULT_TTL_HOURS = 24;

export function createAttentionItem(
  db: DB,
  item: {
    threadId: string;
    kind: string;
    prompt: string;
    options?: string[] | null;
    metadata?: Record<string, unknown> | null;
    continuationToken?: string | null;
  },
): AttentionRow {
  const id = nanoid(16);
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_HOURS * 60 * 60 * 1000).toISOString();
  db.query(
    `INSERT INTO attention_required (id, thread_id, kind, prompt, options, metadata, continuation_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    item.threadId,
    item.kind,
    item.prompt,
    item.options ? JSON.stringify(item.options) : null,
    item.metadata ? JSON.stringify(item.metadata) : null,
    item.continuationToken ?? null,
    expiresAt,
  );
  return getAttentionItem(db, id)!;
}

export function getAttentionItem(db: DB, id: string): AttentionRow | null {
  return db.query("SELECT * FROM attention_required WHERE id = ?").get(id) as AttentionRow | null;
}

export function getPendingAttention(db: DB, threadId?: string): AttentionRow[] {
  if (threadId) {
    return db
      .query("SELECT * FROM attention_required WHERE thread_id = ? AND resolved_at IS NULL ORDER BY created_at DESC")
      .all(threadId) as AttentionRow[];
  }
  return db
    .query("SELECT * FROM attention_required WHERE resolved_at IS NULL ORDER BY created_at DESC")
    .all() as AttentionRow[];
}

export function resolveAttentionItem(
  db: DB,
  id: string,
  resolution: object,
): AttentionRow | null {
  // Idempotent — if already resolved, return existing
  const existing = getAttentionItem(db, id);
  if (!existing) return null;
  if (existing.resolved_at) return existing;

  db.query(
    "UPDATE attention_required SET resolved_at = datetime('now'), resolution = ? WHERE id = ? AND resolved_at IS NULL",
  ).run(JSON.stringify(resolution), id);

  return getAttentionItem(db, id);
}

export function orphanAttentionItems(db: DB, threadId: string, reason: string = "agent_process_exited"): number {
  const resolution = JSON.stringify({ type: "orphaned", reason });
  const result = db.query(
    "UPDATE attention_required SET resolved_at = datetime('now'), resolution = ? WHERE thread_id = ? AND resolved_at IS NULL",
  ).run(resolution, threadId);
  return result.changes;
}

export function expireAttentionItems(db: DB): number {
  const resolution = JSON.stringify({ type: "expired" });
  const result = db.query(
    "UPDATE attention_required SET resolved_at = datetime('now'), resolution = ? WHERE resolved_at IS NULL AND expires_at < datetime('now')",
  ).run(resolution);
  return result.changes;
}

export function attentionRowToApi(row: AttentionRow): import("shared").AttentionItem {
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind as import("shared").AttentionKind,
    prompt: row.prompt,
    options: row.options ? safeJsonParse(row.options) as string[] | null : null,
    metadata: row.metadata ? safeJsonParse(row.metadata) as Record<string, unknown> | null : null,
    continuationToken: row.continuation_token,
    resolvedAt: row.resolved_at,
    resolution: row.resolution ? safeJsonParse(row.resolution) as import("shared").AttentionResolution | null : null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// ── Row types (DB columns use snake_case) ───────────────

export interface ThreadRow {
  id: string;
  title: string;
  agent: string;
  effort_level: string | null;
  project_id: string;
  repo_path: string;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  pr_status: string | null;
  pr_number: number | null;
  pr_status_checked_at: string | null;
  pid: number | null;
  status: string;
  error_message: string | null;
  session_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_interacted_at: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  content: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
  created_at: string;
}

// ── Row → API conversion ────────────────────────────────

export function threadRowToApi(row: ThreadRow): import("shared").Thread {
  return {
    id: row.id,
    title: row.title,
    agent: row.agent,
    effortLevel: row.effort_level as import("shared").EffortLevel | null,
    projectId: row.project_id,
    repoPath: row.repo_path,
    worktree: row.worktree,
    branch: row.branch,
    prUrl: row.pr_url,
    prStatus: row.pr_status as import("shared").PrStatus | null,
    prNumber: row.pr_number,
    pid: row.pid,
    status: row.status as import("shared").ThreadStatus,
    errorMessage: row.error_message,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastInteractedAt: row.last_interacted_at,
  };
  // Note: pr_status_checked_at is intentionally omitted — server-internal only
}

export function messageRowToApi(row: MessageRow): import("shared").Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role as import("shared").MessageRole,
    content: row.content,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    metadata: row.metadata ? safeJsonParse(row.metadata) : null,
    createdAt: row.created_at,
  };
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── Settings helpers ─────────────────────────────────────

export function getSetting(db: DB, key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export function getAllSettings(db: DB): Record<string, string> {
  const rows = db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
