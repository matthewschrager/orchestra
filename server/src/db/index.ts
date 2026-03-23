import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS threads (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    agent       TEXT NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq)`,
  `CREATE TABLE IF NOT EXISTS agent_configs (
    name     TEXT PRIMARY KEY,
    command  TEXT NOT NULL,
    args     TEXT NOT NULL DEFAULT '[]',
    detected INTEGER NOT NULL DEFAULT 0,
    version  TEXT
  )`,
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

  return db;
}

// ── Helpers ─────────────────────────────────────────────

export type DB = Database;

export function getThread(db: DB, id: string) {
  return db.query("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
}

export function listThreads(db: DB) {
  return db
    .query("SELECT * FROM threads WHERE archived_at IS NULL ORDER BY updated_at DESC")
    .all() as ThreadRow[];
}

export function getMessages(db: DB, threadId: string, afterSeq = 0) {
  return db
    .query("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC")
    .all(threadId, afterSeq) as MessageRow[];
}

export function getNextSeq(db: DB, threadId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE thread_id = ?")
    .get(threadId) as { max_seq: number } | null;
  return (row?.max_seq ?? 0) + 1;
}

export function insertMessage(db: DB, msg: MessageRow) {
  db.query(
    `INSERT INTO messages (id, thread_id, seq, role, content, tool_name, tool_input, tool_output, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    msg.id,
    msg.thread_id,
    msg.seq,
    msg.role,
    msg.content,
    msg.tool_name,
    msg.tool_input,
    msg.tool_output,
    msg.metadata,
  );
}

export function updateThread(db: DB, id: string, fields: Partial<ThreadRow>) {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (key === "id") continue;
    sets.push(`${key} = ?`);
    values.push(val as string | number | null);
  }
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.query(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(values as [string, ...string[]]),
  );
}

// ── Row types (DB columns use snake_case) ───────────────

export interface ThreadRow {
  id: string;
  title: string;
  agent: string;
  repo_path: string;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  pid: number | null;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
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
    repoPath: row.repo_path,
    worktree: row.worktree,
    branch: row.branch,
    prUrl: row.pr_url,
    pid: row.pid,
    status: row.status as import("shared").ThreadStatus,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  };
}
