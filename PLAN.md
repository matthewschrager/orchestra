# Fix: AskUserQuestion Repeated Multiple Times

## Problem Statement

When the Claude agent uses AskUserQuestion (a tool that pauses execution to get user input), the same question sometimes appears 2-3 times in the chat — before the user has answered any of them. The user sees duplicate interactive QuestionCards, each with slightly different option text.

## Root Cause

Orchestra uses `permissionMode: "bypassPermissions"` when spawning Claude SDK sessions. With this mode, the SDK's behavior for AskUserQuestion is undocumented — it appears to deny the tool call but then internally retry, producing multiple tool_use events with different `tool_use_id`s within a single session run. Each retry creates a separate attention item AND a separate tool_use message rendered as a QuestionCard.

The parser's `emittedAttentionKeys` dedup (keyed by `tool_use_id`) cannot catch these because each retry has a unique ID.

## Proposed Fix: Use `canUseTool` callback instead of `bypassPermissions`

The SDK provides a `canUseTool` programmatic callback (discovered in SDK v0.2.81 types). This is called before each tool execution and returns a `PermissionResult`:

```typescript
type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny', message: string, interrupt?: boolean };
```

**The `interrupt: true` flag tells the SDK to stop the turn immediately — no retries.**

### The change

Replace `permissionMode: "bypassPermissions"` with a `canUseTool` callback that:
- **Allows** all tools (Bash, Edit, Read, etc.) — same behavior as bypassPermissions
- **Denies with interrupt** AskUserQuestion/AskUserTool — SDK stops immediately, one `permission_denials` entry, one attention item

```typescript
// In claude.ts — both start() and startPersistent()
const sharedOptions = {
  cwd: opts.cwd,
  resume: opts.resumeSessionId,
  allowDangerouslySkipPermissions: true,
  includePartialMessages: true,
  settingSources: ["user", "project", "local"] as const,
  canUseTool: async (toolName: string) => {
    if (ASK_USER_TOOLS.has(toolName)) {
      return { behavior: "deny" as const, message: "Handled by Orchestra", interrupt: true };
    }
    return { behavior: "allow" as const };
  },
};
```

### Also fix: turn_end state bug

Separate from the duplicate issue, the turn_end handler has a state bug. When AskUserQuestion is detected in a stream event (msg A) and then the result event (msg B) arrives with `turn_end`, the per-message `attention` variable is undefined (dedup'd) so the state is set to `"idle"` instead of `"waiting"`.

Fix: check DB for pending attention at turn_end instead of relying on per-message variable:

```typescript
if (isTurnEnd && activeSession.persistent) {
  const hasPendingAttention = getPendingAttention(this.db, threadId).length > 0;
  const newState: SessionState = hasPendingAttention ? "waiting" : "idle";
  activeSession.state = newState;
  turnMessageCount = 0;

  if (!hasPendingAttention) {
    updateThread(this.db, threadId, { status: "done", pid: null });
    this.notifyThread(threadId);
  }
}
```

### Files changed

- `server/src/agents/claude.ts` — replace `permissionMode` with `canUseTool` in both `start()` and `startPersistent()`
- `server/src/sessions/manager.ts` — fix turn_end state to check DB + add `getPendingAttention` import
- `server/src/agents/__tests__/claude.test.ts` — verify parser still works (no changes expected)
- `server/src/sessions/__tests__/sdk-session.test.ts` — test turn_end state fix

### Why this approach

1. **No duplicates produced.** The SDK stops on first AskUserQuestion — no retries, no dedup needed.
2. **Minimal diff.** ~10 lines in `claude.ts`, ~10 lines in `manager.ts`. No new abstractions, no DB queries in the hot path.
3. **Uses SDK's own API.** `canUseTool` is a documented callback on the Options type. We're using the SDK as designed instead of working around undocumented `bypassPermissions` behavior.
4. **Equivalent tool permissions.** `{ behavior: "allow" }` for all other tools = same as `bypassPermissions`.

### Test Plan

1. Existing tests: verify all pass (parser tests, attention tests, session lifecycle)
2. New test: turn_end sets `"waiting"` when DB has pending attention (even if current msg has no attention)
3. New test: turn_end sets `"idle"/"done"` when DB has no pending attention
4. Manual verification: trigger AskUserQuestion in a real session, confirm only one QuestionCard appears

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 0 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement
