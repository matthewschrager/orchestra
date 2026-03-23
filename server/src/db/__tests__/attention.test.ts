import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createAttentionItem,
  getAttentionItem,
  getPendingAttention,
  resolveAttentionItem,
  orphanAttentionItems,
  expireAttentionItems,
  attentionRowToApi,
} from "../index";

// In-memory DB for tests — run migrations inline
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    repo_path TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
    pr_url TEXT, pid INTEGER, status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT, archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS attention_required (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
    kind TEXT NOT NULL, prompt TEXT NOT NULL, options TEXT, metadata TEXT,
    continuation_token TEXT, resolved_at TEXT, resolution TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attention_pending
    ON attention_required(thread_id, resolved_at) WHERE resolved_at IS NULL`);

  // Insert a test thread
  db.query(
    "INSERT INTO threads (id, title, agent, repo_path, status) VALUES (?, ?, ?, ?, ?)",
  ).run("thread-1", "Test thread", "claude", "/tmp/repo", "running");
  db.query(
    "INSERT INTO threads (id, title, agent, repo_path, status) VALUES (?, ?, ?, ?, ?)",
  ).run("thread-2", "Other thread", "claude", "/tmp/repo2", "running");

  return db;
}

describe("attention_required CRUD", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test("createAttentionItem inserts and returns a row", () => {
    const row = createAttentionItem(db, {
      threadId: "thread-1",
      kind: "ask_user",
      prompt: "Which color?",
      options: ["Red", "Blue", "Green"],
      metadata: { toolName: "AskUserQuestion" },
      continuationToken: "session-abc",
    });

    expect(row.id).toBeTruthy();
    expect(row.thread_id).toBe("thread-1");
    expect(row.kind).toBe("ask_user");
    expect(row.prompt).toBe("Which color?");
    expect(JSON.parse(row.options!)).toEqual(["Red", "Blue", "Green"]);
    expect(JSON.parse(row.metadata!)).toEqual({ toolName: "AskUserQuestion" });
    expect(row.continuation_token).toBe("session-abc");
    expect(row.resolved_at).toBeNull();
    expect(row.expires_at).toBeTruthy();
  });

  test("getAttentionItem retrieves by id", () => {
    const created = createAttentionItem(db, {
      threadId: "thread-1",
      kind: "permission",
      prompt: "Run bash: rm -rf dist/",
    });

    const fetched = getAttentionItem(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.kind).toBe("permission");
  });

  test("getAttentionItem returns null for unknown id", () => {
    expect(getAttentionItem(db, "nonexistent")).toBeNull();
  });

  test("getPendingAttention returns only unresolved items", () => {
    createAttentionItem(db, {
      threadId: "thread-1",
      kind: "ask_user",
      prompt: "Q1",
    });
    const item2 = createAttentionItem(db, {
      threadId: "thread-1",
      kind: "ask_user",
      prompt: "Q2",
    });
    // Resolve one
    resolveAttentionItem(db, item2.id, { type: "user", text: "answer" });

    const pending = getPendingAttention(db, "thread-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("Q1");
  });

  test("getPendingAttention without threadId returns all pending", () => {
    createAttentionItem(db, { threadId: "thread-1", kind: "ask_user", prompt: "Q1" });
    createAttentionItem(db, { threadId: "thread-2", kind: "permission", prompt: "Q2" });

    const all = getPendingAttention(db);
    expect(all).toHaveLength(2);
  });

  test("resolveAttentionItem is idempotent", () => {
    const item = createAttentionItem(db, {
      threadId: "thread-1",
      kind: "ask_user",
      prompt: "Pick one",
      options: ["A", "B"],
    });

    const first = resolveAttentionItem(db, item.id, { type: "user", optionIndex: 0 });
    expect(first!.resolved_at).toBeTruthy();

    // Second resolution returns the same result without updating
    const second = resolveAttentionItem(db, item.id, { type: "user", optionIndex: 1 });
    expect(second!.resolved_at).toBe(first!.resolved_at);
    expect(JSON.parse(second!.resolution!).optionIndex).toBe(0); // First wins
  });

  test("resolveAttentionItem returns null for unknown id", () => {
    expect(resolveAttentionItem(db, "nonexistent", { type: "user" })).toBeNull();
  });

  test("orphanAttentionItems marks all pending items for a thread", () => {
    createAttentionItem(db, { threadId: "thread-1", kind: "ask_user", prompt: "Q1" });
    createAttentionItem(db, { threadId: "thread-1", kind: "permission", prompt: "Q2" });
    createAttentionItem(db, { threadId: "thread-2", kind: "ask_user", prompt: "Q3" });

    const count = orphanAttentionItems(db, "thread-1");
    expect(count).toBe(2);

    // thread-1 items are resolved as orphaned
    const pending1 = getPendingAttention(db, "thread-1");
    expect(pending1).toHaveLength(0);

    // thread-2 item is unaffected
    const pending2 = getPendingAttention(db, "thread-2");
    expect(pending2).toHaveLength(1);
  });

  test("expireAttentionItems marks items past their TTL", () => {
    // Create an item with an already-expired TTL
    const id = "expire-test";
    db.query(
      `INSERT INTO attention_required (id, thread_id, kind, prompt, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '-1 hour'))`,
    ).run(id, "thread-1", "ask_user", "Old question");

    // Also create a non-expired item
    createAttentionItem(db, { threadId: "thread-1", kind: "ask_user", prompt: "Fresh question" });

    const count = expireAttentionItems(db);
    expect(count).toBe(1);

    const expired = getAttentionItem(db, id);
    expect(expired!.resolved_at).toBeTruthy();
    expect(JSON.parse(expired!.resolution!).type).toBe("expired");

    // Fresh item is still pending
    const pending = getPendingAttention(db, "thread-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("Fresh question");
  });

  test("attentionRowToApi converts snake_case to camelCase", () => {
    const row = createAttentionItem(db, {
      threadId: "thread-1",
      kind: "ask_user",
      prompt: "Pick color",
      options: ["Red", "Blue"],
      continuationToken: "sess-123",
    });

    const api = attentionRowToApi(row);
    expect(api.threadId).toBe("thread-1");
    expect(api.kind).toBe("ask_user");
    expect(api.options).toEqual(["Red", "Blue"]);
    expect(api.continuationToken).toBe("sess-123");
    expect(api.resolvedAt).toBeNull();
    expect(api.resolution).toBeNull();
    expect(api.createdAt).toBeTruthy();
  });
});
