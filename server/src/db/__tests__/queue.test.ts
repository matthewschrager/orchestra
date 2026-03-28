import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  enqueueMessage,
  dequeueNextMessage,
  countPendingQueue,
  cleanDeliveredQueue,
} from "../index";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    repo_path TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    content TEXT NOT NULL,
    attachments TEXT,
    interrupt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_pending
    ON message_queue(thread_id, delivered_at) WHERE delivered_at IS NULL`);

  db.exec(`INSERT INTO threads (id, title, agent, repo_path, status) VALUES ('t1', 'Test', 'mock', '/tmp', 'running')`);
  db.exec(`INSERT INTO threads (id, title, agent, repo_path, status) VALUES ('t2', 'Test2', 'mock', '/tmp', 'running')`);

  return db;
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

describe("message_queue", () => {
  test("enqueueMessage creates a pending row", () => {
    const row = enqueueMessage(db, "t1", "hello");
    expect(row.thread_id).toBe("t1");
    expect(row.content).toBe("hello");
    expect(row.delivered_at).toBeNull();
    expect(row.interrupt).toBe(0);
  });

  test("enqueueMessage stores interrupt flag", () => {
    const row = enqueueMessage(db, "t1", "urgent", null, true);
    expect(row.interrupt).toBe(1);
  });

  test("enqueueMessage stores attachments", () => {
    const attachments = JSON.stringify([{ id: "a1", filename: "test.png" }]);
    const row = enqueueMessage(db, "t1", "with files", attachments);
    expect(row.attachments).toBe(attachments);
  });

  test("countPendingQueue counts only undelivered messages", () => {
    expect(countPendingQueue(db, "t1")).toBe(0);
    enqueueMessage(db, "t1", "msg1");
    enqueueMessage(db, "t1", "msg2");
    expect(countPendingQueue(db, "t1")).toBe(2);

    // Manually mark one as delivered
    const all = db.query("SELECT id FROM message_queue").all() as Array<{ id: string }>;
    db.query("UPDATE message_queue SET delivered_at = datetime('now') WHERE id = ?").run(all[0]!.id);
    expect(countPendingQueue(db, "t1")).toBe(1);
  });

  test("countPendingQueue is per-thread", () => {
    enqueueMessage(db, "t1", "msg1");
    enqueueMessage(db, "t2", "msg2");
    expect(countPendingQueue(db, "t1")).toBe(1);
    expect(countPendingQueue(db, "t2")).toBe(1);
  });

  test("dequeueNextMessage claims the oldest pending message", () => {
    enqueueMessage(db, "t1", "first");
    enqueueMessage(db, "t1", "second");

    const dequeued = dequeueNextMessage(db, "t1");
    expect(dequeued).not.toBeNull();
    expect(dequeued!.content).toBe("first");
    expect(dequeued!.delivered_at).not.toBeNull();

    // Second dequeue gets the second message
    const dequeued2 = dequeueNextMessage(db, "t1");
    expect(dequeued2!.content).toBe("second");

    // Third dequeue returns null (queue empty)
    expect(dequeueNextMessage(db, "t1")).toBeNull();
  });

  test("dequeueNextMessage is atomic — prevents double-drain", () => {
    enqueueMessage(db, "t1", "only one");

    // Simulate two concurrent dequeue attempts
    const first = dequeueNextMessage(db, "t1");
    expect(first).not.toBeNull();

    // Second attempt returns null (already claimed)
    const second = dequeueNextMessage(db, "t1");
    expect(second).toBeNull();
  });

  test("dequeueNextMessage returns null for empty queue", () => {
    expect(dequeueNextMessage(db, "t1")).toBeNull();
  });

  test("dequeueNextMessage returns null for wrong thread", () => {
    enqueueMessage(db, "t1", "msg");
    expect(dequeueNextMessage(db, "t2")).toBeNull();
  });

  test("cleanDeliveredQueue removes old delivered entries", () => {
    const row = enqueueMessage(db, "t1", "msg");
    // Mark as delivered 2 hours ago
    db.query("UPDATE message_queue SET delivered_at = datetime('now', '-2 hours') WHERE id = ?").run(row.id);

    const cleaned = cleanDeliveredQueue(db);
    expect(cleaned).toBe(1);

    // Queue should be empty
    const remaining = db.query("SELECT COUNT(*) as cnt FROM message_queue").get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  test("cleanDeliveredQueue keeps recent delivered entries", () => {
    const row = enqueueMessage(db, "t1", "msg");
    db.query("UPDATE message_queue SET delivered_at = datetime('now') WHERE id = ?").run(row.id);

    const cleaned = cleanDeliveredQueue(db);
    expect(cleaned).toBe(0);
  });

  test("cleanDeliveredQueue keeps pending entries", () => {
    enqueueMessage(db, "t1", "msg");
    const cleaned = cleanDeliveredQueue(db);
    expect(cleaned).toBe(0);
  });
});
