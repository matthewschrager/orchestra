# Command Queue Visibility, Cancel & Steering

**Branch:** orchestra/orchestra-mx405vfykos
**Problem:** When users send messages while the agent is working, Orchestra shows "N queued" in the StickyRunBar but provides no way to see what's queued, cancel a queued command, or "steer" the agent by injecting a message into the current turn immediately.

## Current State

- Messages sent mid-turn are persisted to `message_queue` SQLite table and injected via `streamInput()` with `priority: 'next'`
- StickyRunBar shows `· N queued` as a plain text count
- Individual queued messages show a clock icon + "Queued" label below the bubble
- `interrupt: true` flag already exists in the WS protocol, mapping to `priority: 'now'` — this IS steering, but it's only used internally for attention resolution, never exposed as a user action
- No cancel API exists — once enqueued, messages cannot be removed
- Max queue depth: 5 messages per turn

## Goals

1. **Queue visibility**: Users can see the actual content of each queued message
2. **Cancel**: Users can remove any queued message before the agent processes it
3. **Steer**: Users can inject a message into the current turn immediately (Codex-style `turn/steer`)
4. **Clear separation**: Queue (safe, deferred) and Steer (immediate injection) are distinct, deliberate actions

## Codex Reference

Codex CLI separates mid-turn input into two operations:
- **Steer** (Enter): Injects into current turn immediately. Agent receives it as additive context. Can derail.
- **Queue** (Tab): Deferred to next turn. Safe. Default in newer versions.
- Queue is the safer default — accidental sends don't disrupt the agent's current task

## Design

### A. Queue Drawer (StickyRunBar expansion)

Replace the static "· N queued" text with an interactive, expandable queue drawer:

```
┌─────────────────────────────────────────────────────────┐
│ ⟳ Thinking… editing server/src/foo.ts   42s  · 2 queued │  ← click "2 queued" to expand
├─────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────┐       │
│  │ "Now also update the tests for..."   [▶][✕]  │       │  ← queued msg 1: Send Now / Cancel
│  │ "And add a changelog entry"          [▶][✕]  │       │  ← queued msg 2: Send Now / Cancel
│  └──────────────────────────────────────────────┘       │
│                                         [Clear All]     │
└─────────────────────────────────────────────────────────┘
```

- Expandable: Click "N queued" badge → slides down a panel showing each queued message
- Each message shows truncated content (first ~80 chars)
- **[▶] Send Now**: Promotes this message from queue to immediate steer (changes priority to "now")
- **[✕] Cancel**: Removes message from queue entirely
- **[Clear All]**: Removes all queued messages
- Collapse: Click badge again or auto-collapse when queue empties

### B. InputBar Split-Send (Queue vs Steer)

When the agent is running, the Send button becomes a split button:

```
┌────────────────────────────────────────────────────┐
│  Type a message...                                  │
│                                                     │
│                        [Queue ▾]   or   [⚡ Steer]  │
└────────────────────────────────────────────────────┘
```

- **Queue** (default, Enter key): Defers message to next turn. Safe. Same as current behavior.
- **Steer** (Cmd/Ctrl+Enter): Injects into current turn immediately with `priority: 'now'`. Shows distinct visual (lightning icon, different color) to communicate "this interrupts the current task."
- The split button dropdown lets user swap the default if they prefer steer-first.
- When agent is idle, just shows normal "Send" button (no split).

### C. Queue Cancel API

New server-side cancel endpoint + WS message:

```typescript
// New WS client message
| { type: "cancel_queued"; threadId: string; queueId: string }
| { type: "clear_queue"; threadId: string }

// New DB function
cancelQueuedMessage(db, queueId): boolean  // DELETE WHERE id = ? AND delivered_at IS NULL
clearPendingQueue(db, threadId): number     // DELETE WHERE thread_id = ? AND delivered_at IS NULL

// New WS server response
| { type: "queue_updated"; threadId: string; queue: QueuedItem[] }
```

The `queue_updated` message replaces `queued_message` count-only deltas with full queue state so the client can render actual message content.

### D. Queue State Broadcasting

Replace the current count-only `queued_message` delta with a richer `queue_updated` message:

```typescript
interface QueuedItem {
  id: string;
  content: string;       // First ~200 chars of the original message
  createdAt: string;
  interrupt: boolean;     // Was this originally sent as a steer?
}

// StreamDelta gains:
queueItems?: QueuedItem[];
```

On every queue mutation (enqueue, cancel, deliver, clear), broadcast the full pending queue state to all subscribed clients.

## Implementation Plan

### Step 1: Server — Queue cancel + clear APIs
**Files:** `server/src/db/index.ts`, `server/src/sessions/manager.ts`, `server/src/ws/handler.ts`, `shared/src/types.ts`

1. Add `cancelQueuedMessage(db, queueId)` and `clearPendingQueue(db, threadId)` to db/index.ts
2. Add `getPendingQueue(db, threadId)` to return full queue items (id, content truncated, createdAt, interrupt)
3. Add `cancelQueued(threadId, queueId)` and `clearQueue(threadId)` methods to SessionManager
4. Add `cancel_queued` and `clear_queue` WS message handlers
5. Replace `queued_message` delta with `queue_updated` that includes full item list
6. Update `WSClientMessage` and `WSServerMessage` types in shared/types.ts

### Step 2: Server — Steer support (promote queued → immediate)
**Files:** `server/src/sessions/manager.ts`, `server/src/ws/handler.ts`, `shared/src/types.ts`

1. Add `steerMessage(threadId, queueId)` to SessionManager — cancels the queued entry and re-injects with `priority: 'now'`
2. Add `steer_queued` WS message type
3. Ensure `interrupt: true` on `send_message` already provides steer for NEW messages (it does, via existing code path)

### Step 3: Client — Queue Drawer in StickyRunBar
**Files:** `client/src/components/StickyRunBar.tsx`, `client/src/App.tsx`, `client/src/components/ChatView.tsx`

1. Add `queueItems` prop to StickyRunBar (array of QueuedItem, not just count)
2. Add expandable drawer: click "N queued" → shows list of queued messages with Send Now / Cancel buttons
3. Wire cancel/steer/clear actions through WS
4. Update streaming reducer to track `queueItems` map instead of `queuedCount`
5. Update `MessageBubble` isQueued indicator — can now cross-reference by queue ID
6. Auto-collapse drawer when queue empties
7. Animate expand/collapse with CSS transitions

### Step 4: Client — InputBar Split-Send
**Files:** `client/src/components/InputBar.tsx`

1. When `isRunning`, render split button: primary "Queue" + secondary "Steer" (or vice versa based on preference)
2. Queue = `onSend(content, attachments, false)` — deferred delivery
3. Steer = `onSend(content, attachments, true)` — immediate injection (`interrupt: true`)
4. Keyboard shortcuts: Enter = primary action (queue), Cmd/Ctrl+Enter = secondary (steer)
5. Visual differentiation: Steer button uses warning/accent color + lightning icon
6. Tooltip explaining the difference on hover

### Step 5: Client — Queue Badge in MessageBubble
**Files:** `client/src/components/ChatView.tsx`

1. Update "Queued" badge on message bubbles to include Cancel button (small ✕)
2. Clicking ✕ sends `cancel_queued` WS message
3. When message is delivered (removed from queue), badge changes from "Queued" → "Delivered" briefly, then disappears

### Step 6: Tests
**Files:** `server/src/db/__tests__/queue.test.ts`, `server/src/sessions/__tests__/sdk-session.test.ts`, `client/src/components/__tests__/StickyRunBar.test.ts`

1. Unit tests for `cancelQueuedMessage`, `clearPendingQueue`, `getPendingQueue`
2. Test cancel of already-delivered message returns false
3. Test steer promotion: cancel + re-inject with priority 'now'
4. Test `queue_updated` broadcast on enqueue/cancel/clear
5. Test split-send keyboard shortcuts
6. Test queue drawer expand/collapse
7. Test MessageBubble cancel integration

### Step 7: Mobile
**Files:** `client/src/components/InputBar.tsx`, `client/src/components/StickyRunBar.tsx`

1. On mobile, split-send becomes a long-press menu or a toggle button (no hover states)
2. Queue drawer adapts to smaller width — full-width messages, stacked buttons
3. Touch-friendly cancel/steer targets (min 44px)

## Edge Cases

- **Race: cancel after delivery**: `cancelQueuedMessage` uses `WHERE delivered_at IS NULL` guard — returns false if already delivered. Client shows "already sent" toast.
- **Race: steer after turn_end**: If turn just ended, steer falls through to normal message delivery. No harm.
- **Queue full + cancel**: After canceling a message, queue count decreases, allowing new messages. `queuedThisTurn` counter on persistent sessions must also decrement.
- **Multiple clients**: `queue_updated` broadcasts to all subscribed WS clients, keeping queue state in sync cross-device.
- **Large message content**: Truncate to 200 chars in `QueuedItem.content` for broadcast efficiency. Full content stays in SQLite.
- **Persistent vs non-persistent sessions**: Cancel must work for both. For persistent sessions where message was already injected via `streamInput()`, cancel is best-effort (mark delivered, agent may still process it).

## Not in Scope

- Queue reordering (drag-and-drop to change execution order)
- Queue message editing (modify content before delivery)
- Persistent "send as steer by default" user preference (can be added later via Settings)
- Pause agent functionality (freeze agent mid-task while composing a steer)
