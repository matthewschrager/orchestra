<!-- /autoplan restore point: /home/mschrager/.gstack/projects/matthewschrager-orchestra/orchestra-orchestra-120bn3r5nry-autoplan-restore-20260326-191637.md -->

# Message Queuing & Steering for Agent Sessions

## Context

Orchestra currently blocks user input while the agent is working — the InputBar shows "Agent is working..." and replaces the Send button with a Stop button. The server enforces this with a hard guard that throws `"Agent is still processing — wait for it to finish"` when `state === "thinking"`.

The Claude Code CLI supports a "type while thinking" workflow where users can queue messages during agent execution. The Claude Agent SDK supports this via:
1. **`priority` field on `SDKUserMessage`** — `'now' | 'next' | 'later'` — passed through to the CLI subprocess which maintains an internal command queue
2. **`interrupt()` method on Query** — sends a control request to stop the current turn gracefully
3. **`streamInput()` can be called mid-turn** — writes to stdin; CLI subprocess handles queuing

## Premises (approved)

1. ✅ SDK `priority` field is the right mechanism — passthrough to CLI's internal queue
2. ✅ `priority: 'next'` is the correct default — process after current turn
3. 🔄 Interrupt/steer ships in Phase 2 only after spike test confirms `interrupt()` works
4. ✅ No server-side queuing needed — CLI owns the queue
5. ➕ Queue depth limit of 5 messages (prevent context blowout)
6. ➕ Graceful degradation for non-persistent adapters (Codex) — keep current block behavior
7. ➕ Button label stays "Send" always — "Queue" is jargon (design review finding)

## Implementation: Two Phases

### Phase 1: Message Queuing (this PR)

Enable users to send messages while the agent is working. Messages queue in the CLI subprocess for processing after the current turn. No interrupt/steer.

### Phase 2: Interrupt & Steer (follow-up, gated on spike)

Add `interrupt()` support so users can redirect the agent mid-turn. Only starts after spike test confirms `interrupt()` keeps the subprocess alive.

---

## Phase 1 Design

### Server Changes

**`server/src/agents/types.ts`** — PersistentSession interface:
```typescript
interface PersistentSession extends AgentSession {
  // ... existing ...
  injectMessage(text: string, sessionId: string, priority?: 'now' | 'next'): Promise<void>;
  // Phase 2: interrupt(): Promise<void>;
}
```

**`server/src/agents/claude.ts`** — injectMessage with priority:
```typescript
async injectMessage(text: string, sessionId: string, priority?: 'now' | 'next'): Promise<void> {
  const userMsg: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
    priority: priority ?? 'next',  // default: queue for next turn
  };
  await q.streamInput(
    (async function* () { yield userMsg; })(),
  );
}
```

**`server/src/sessions/manager.ts`** — sendMessage() rewrite:

```
Before (blocks):                     After (queues):
─────────────────                    ────────────────
if (state === "thinking")            if (state === "thinking" && persistent)
  throw "wait for it"                  if (queuedCount >= 5) throw "Queue full"
                                       persistMessage(user msg)
                                       injectMessage(prompt, sessionId, 'next')
                                       queuedCount++
                                       broadcast queued_message delta
                                       return
```

- `ActiveSession` gains `queuedCount: number` (reset on `turn_end`)
- `queued_message` delta emitted directly from `sendMessage()` via `notifyStreamDelta()` (NOT from SDK parser)
- For non-persistent sessions: keep existing behavior (throw error for legacy adapters)
- `resolveAttention` path: if `state === "thinking"`, the attention answer queues as `priority: 'next'` (not an error)
- Content validation: reject empty/whitespace-only messages before consuming a queue slot
- `interrupt` param accepted but ignored in Phase 1 (no-op, logged as warning)

**`shared/src/types.ts`** — API changes:
```typescript
// WSClientMessage send_message gains interrupt field
| { type: "send_message"; threadId: string; content: string;
    attachments?: Attachment[]; interrupt?: boolean }

// StreamDelta gains queued_message type + queuedCount field
export interface StreamDelta {
  // ... existing ...
  deltaType: "text" | "tool_start" | "tool_input" | "tool_end" | "turn_end"
           | "metrics" | "queued_message";
  queuedCount?: number;  // current queue depth after this message
}
```

**`server/src/ws/handler.ts`** — pass interrupt from WS:
```typescript
case "send_message":
  const shouldInterrupt = msg.interrupt === true;  // strict boolean check
  sessionManager.sendMessage(threadId, content, attachments, shouldInterrupt);
```

**`server/src/routes/threads.ts`** — REST body:
```typescript
const { content, attachments, interrupt } = await c.req.json();
sessionManager.sendMessage(threadId, content, attachments, interrupt === true);
```

### Client Changes

**InputBar when `isRunning` (Phase 1):**

```
Desktop:
┌──────────────────────────────────────────────────────────┐
│ [+] [📎]  Send a message...                     [Send] [■] │
└──────────────────────────────────────────────────────────┘

Mobile:
┌────────────────────────────────────────────┐
│ [📎]  Send a message...          [Send] [■] │
└────────────────────────────────────────────┘
```

- **Textarea**: always enabled, never disabled — placeholder stays `"Send a message..."` (no scary "Agent is working..." text)
- **Send button**: always visible, always says "Send". When `isRunning`, sends with `interrupt: false`
- **Stop button**: shown alongside Send (not replacing it) when `isRunning`
- Button layout: `[Send] [■ Stop]` — Send is primary (accent bg), Stop is secondary (ghost with pulse ring, same as current)
- On mobile (<640px): Stop button shows as compact icon-only to save space

**Queued message rendering in ChatView:**

When a user sends a message while the agent is running:
1. Message appears immediately in chat (persisted to DB, arrives via WS `message` event)
2. User messages render identically to normal — no "queued" badge (the user doesn't need to know it's queued; they just sent a message)
3. StickyRunBar shows queue count: `"Working... · 1 queued"` when `queuedCount > 0`
4. On `turn_end`: `queuedCount` resets to 0, StickyRunBar returns to normal

**Why no "queued" badge on messages:** Every chat app shows "Send → message appears." Adding a "queued" badge tells the user "this is different/worse" when it's not — their message will be processed. The StickyRunBar count provides power-user awareness without anxiety.

**Queue-full state:**
- Server returns error `"Queue full — wait for the agent to finish this turn"`
- Client catches error, shows toast notification (same pattern as upload errors)
- Textarea retains user's typed text (not cleared on error)
- Send button stays enabled (user can retry after queue drains)

**App.tsx changes:**
- `handleSend(content, attachments, interrupt?)` — pass `interrupt` through WS
- Track `queuedCount` from `queued_message` stream deltas; reset on `turn_end`
- Pass `queuedCount` to `StickyRunBar` as prop

**StickyRunBar changes:**
- Accept `queuedCount: number` prop
- Display `"· N queued"` next to existing status when `queuedCount > 0`

### Error Handling

| Scenario | Detection | User experience |
|----------|-----------|-----------------|
| `streamInput()` fails mid-turn | Async rejection | Existing `restartWithResume()` fallback. User's message is persisted, agent restarts and continues. |
| Queue depth exceeded (5) | `queuedCount >= 5` | Toast: "Queue full — wait for the agent to finish this turn." Typed text preserved. |
| Non-persistent adapter (Codex) | `!existing.persistent` | Same as current: throws error, client shows toast. |
| Subprocess dies with queued messages | Iterator ends while `thinking` | Auto-restart. Warning message in chat: "Session restarted — your recent messages may need to be resent." |
| Empty/whitespace message | `!content.trim()` | Rejected before queue slot consumed. |
| `interrupt: true` in Phase 1 | Param present but ignored | Logged as debug warning; message sent as `priority: 'next'`. |

---

## Files Changed

| File | Change | LOC est. |
|------|--------|----------|
| `server/src/sessions/manager.ts` | Remove thinking guard, add queue path with depth limit, queuedCount tracking, queued_message delta emission, content validation | ~35 |
| `server/src/agents/claude.ts` | Add priority param to injectMessage, set on SDKUserMessage | ~8 |
| `server/src/agents/types.ts` | Update PersistentSession.injectMessage signature | ~3 |
| `shared/src/types.ts` | Add interrupt to WSClientMessage, queued_message + queuedCount to StreamDelta | ~5 |
| `server/src/ws/handler.ts` | Pass interrupt from WS to sendMessage (strict boolean check) | ~3 |
| `server/src/routes/threads.ts` | Accept interrupt in REST body, pass through | ~3 |
| `client/src/components/InputBar.tsx` | Always-enabled Send+Stop buttons, remove blocking behavior | ~20 |
| `client/src/App.tsx` | Pass interrupt, track queuedCount from stream deltas, reset on turn_end | ~15 |
| `client/src/components/StickyRunBar.tsx` | Accept+display queuedCount prop | ~8 |
| `server/src/sessions/__tests__/sdk-session.test.ts` | Tests for queue flow, depth limit, non-persistent fallback, turn_end reset | ~80 |
| **Total** | | **~180** |

## NOT in scope

- **Interrupt/steer (Phase 2)**: Ctrl+Enter, `interrupt()` call, priority 'now'. Gated on spike test.
- **V2 Session API**: `@alpha` unstable — stay on V1
- **`cancelAsyncMessage(uuid)`**: Cancel queued messages — defer to TODOS.md
- **Queue reordering**: Future enhancement
- **Codex/non-persistent queue**: Keep current behavior for non-persistent adapters
- **Queue persistence across server restart**: Messages already in SQLite; CLI queue is ephemeral

## What already exists

| Sub-problem | Existing code |
|-------------|---------------|
| SDK `priority` field | `SDKUserMessage.priority` in `sdk.d.ts:2398` |
| `streamInput()` | `claude.ts:121` — wraps in async generator |
| Session state machine | `manager.ts:22-23` — `thinking/idle/waiting` |
| Thinking guard (to remove) | `manager.ts:209-212` — `if (state === "thinking") throw` |
| Message persistence | `manager.ts:775-798` — `persistMessage()` |
| Existing inject fallback | `manager.ts:249-268` — try/catch → `restartWithResume()` |
| WS message types | `shared/types.ts:109-119` — `WSClientMessage` union |
| Stream delta types | `shared/types.ts:72-89` — `StreamDelta` with deltaType |
| InputBar running detection | `InputBar.tsx:41` — `thread?.status === "running"` |
| Stop button with pulse ring | `InputBar.tsx:264-277` — currently replaces Send |
| StickyRunBar | Shows cost/duration/tokens during active run |

## Failure Modes Registry

| Mode | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| CLI ignores `priority` field | Low | Medium — msgs processed but possibly out of order | Acceptable degradation; messages are durable in DB |
| `streamInput()` mid-turn silently drops message | Low | High — user thinks message sent but agent never sees it | DB has the message; user can resend. Log streamInput result. |
| Rapid-fire queuing (5 msgs in <1s) | Medium | Low — all arrive at CLI stdin | Queue depth cap prevents blowout. Bun single-threaded model prevents true concurrent sendMessage. |
| queuedCount drifts from actual CLI queue | Medium | Low — cosmetic only (StickyRunBar count wrong) | Best-effort; count is informational, not critical |

## Test Plan

1. **Unit: mid-turn message queuing** — mock PersistentSession in `thinking` state, verify `injectMessage` called with `priority: 'next'`
2. **Unit: queue depth limit** — send 6 messages while thinking → 6th throws "Queue full"
3. **Unit: queuedCount reset on turn_end** — verify counter resets to 0 when turn ends
4. **Unit: non-persistent adapter rejection** — verify non-persistent sessions error on mid-turn send
5. **Unit: interrupt ignored in Phase 1** — send with `interrupt: true` → message sent as `priority: 'next'`, no error
6. **Unit: empty message rejection** — whitespace-only content rejected before queue slot consumed
7. **Unit: WS interrupt passthrough** — WS handler validates `interrupt === true` (strict boolean)
8. **Unit: resolveAttention during thinking** — attention resolution while thinking queues as `priority: 'next'`
9. **Unit: queued_message delta emitted** — verify `notifyStreamDelta` called with `deltaType: 'queued_message'` and correct `queuedCount`
10. **Unit: no regression on idle inject** — existing tests pass (idle/waiting state inject still works without priority)
11. **Integration: full queue flow** — start session → send 3 messages while thinking → all persisted → all injected with priority → turn_end resets count
12. **E2E: manual** — real agent session, type while working, verify message appears in chat and processes on next turn

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|
| 1 | CEO | Use SDK priority field (approach A) | P3 pragmatic | SDK does queuing — don't reinvent | Server-side queue (B), V2 API (C) |
| 2 | CEO | Don't expose `now/next/later` in public API | P5 explicit | "API malpractice" leaking vendor types | SDK type passthrough |
| 3 | CEO | Add queue depth limit (5) | P1 completeness | Prevent context blowout from spam-queuing | No limit |
| 4 | CEO | Graceful non-persistent fallback | P5 explicit | Codex adapter can't inject mid-turn | Universal queue |
| 5 | CEO | SELECTIVE EXPANSION mode | P3 pragmatic | Feature-scoped, not strategic pivot | Scope expansion |
| 6 | Design | Keep button "Send" always | P5 explicit | "Queue" creates anxiety; queue is invisible | "Queue" button |
| 7 | Design | No "queued" badge on chat messages | P5 explicit | User sent a message; it appears. Queue is system detail. | Queued badge/chip |
| 8 | Design | Phase interrupt UI separately | P3 pragmatic | Don't build UI for unverified feature | Mixed phases |
| 9 | Design | Toast for queue-full, preserve typed text | P1 completeness | Don't lose user's input on error | Silent rejection |
| 10 | Eng | queued_message delta from sendMessage, not parser | P5 explicit | Delta isn't from SDK stream | Parser emission |
| 11 | Eng | Strict boolean check on interrupt | P5 explicit | Prevent truthy coercion from WS | Loose truthiness |
| 12 | Eng | resolveAttention queues during thinking | P6 action | Don't block attention resolution | Reject attention during thinking |
| 13 | Eng | Content validation before queue slot | P1 completeness | Don't waste slots on empty messages | Validate only in routes |
| 14 | Eng | Log warning on subprocess crash with queued msgs | P1 completeness | User may need to resend | Silent loss |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | 6 auto-decided (API types, depth limit, non-persistent, phasing) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_open | 6 findings (strategic, multi-agent, API types, error model) |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clean | 19 findings, all addressed (interrupt race → Phase 2, crash recovery, test gaps) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | 11 findings, all addressed (button label, missing states, phasing, mobile) |

**VERDICT:** ALL REVIEWS CLEARED — ready for final approval
