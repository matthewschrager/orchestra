# Context Usage Persistence Across Refresh

**Current Branch:** `orchestra/orchestra-t6dn3j268k`

## Problem

The StickyRunBar context-usage/session summary is derived from ephemeral stream deltas in client memory. After a page refresh, the client reloads persisted messages and thread state, but not the usage metrics, so the context window indicator and session summary disappear until new metrics arrive.

## Current State

- `client/src/App.tsx` keeps usage in `StreamingState.metrics`, a `Map<string, TurnMetrics>` that starts empty on load.
- The reducer updates that map only from `stream_delta` metrics events.
- `server/src/ws/handler.ts` explicitly treats stream deltas as ephemeral and does not replay metrics on subscribe.
- `server/src/db/index.ts` does not persist thread-level usage metrics.
- On refresh, the client reloads messages and Todo state, but not metrics.

## Goals

1. Context usage survives page refresh and reconnect.
2. The idle StickyRunBar still shows session summary and last-turn usage after refresh.
3. A mid-turn refresh restores the latest known token/context snapshot immediately.
4. The server is the source of truth, so refresh works across tabs/devices.
5. Keep the implementation small and aligned with the current data flow.

## Non-Goals

- Full historical per-turn analytics or charts.
- Persisting streaming text/tool draft state.
- Redesigning the StickyRunBar UI.

## Design

### 1. Persist thread-level usage state

Persist the metrics the StickyRunBar actually needs on the `threads` row:

- `metrics_turn_count`
- `metrics_total_duration_ms`
- `metrics_total_cost_usd`
- `metrics_latest_input_tokens`
- `metrics_latest_output_tokens`
- `metrics_latest_context_window`
- `metrics_latest_model_name`
- `metrics_active_turn_started_at`

These fields represent:

- **Session totals:** turn count, total duration, total cost.
- **Latest turn snapshot:** input/output tokens, context window, model name.
- **Current turn timing:** explicit start time for the active turn.

This is the smallest read model that matches the current StickyRunBar behavior.

### 2. Make `Thread` expose persisted metrics

Add a nested metrics object to the shared `Thread` type:

```ts
interface PersistedThreadMetrics {
  turnCount: number;
  totalDurationMs: number;
  totalCostUsd: number;
  latestInputTokens: number;
  latestOutputTokens: number;
  latestContextWindow: number;
  latestModelName: string | null;
  activeTurnStartedAt: string | null;
}
```

Thread APIs (`listThreads`, `getThread`, `thread_updated`) should return this as part of `Thread`.

### 3. Update persisted metrics inside `SessionManager`

Add one helper in `server/src/sessions/manager.ts`, something like:

```ts
private applyMetricsDelta(threadId: string, delta: StreamDelta): void
```

Rules:

- On turn start:
  - set `metrics_active_turn_started_at = now`
  - reset `metrics_latest_input_tokens = 0`
  - reset `metrics_latest_output_tokens = 0`
- On every metrics delta:
  - overwrite latest input/output/context/model fields when present
  - increment total duration/cost/turn count only for completed-turn metrics
- On turn end / done / waiting / error / stop:
  - clear `metrics_active_turn_started_at`
  - keep latest snapshot so idle state still shows the last turn's usage

Important: use `updateThreadSilent`, not `updateThread`, for metrics writes so the sidebar sort order does not thrash on every stream update.

### 4. Hydrate client metrics from thread data

On the client, stop treating metrics as purely in-memory bootstrap data.

Use thread-level metrics as the refresh baseline:

- when `listThreads()` resolves
- when `getThread()` / subscribe `thread_updated` arrives
- when the active thread changes

Two acceptable implementations:

- Add a reducer action like `hydrate_metrics_from_thread`
- Or derive a base `TurnMetrics` object from `thread.metrics` and layer live deltas on top

The first option is simpler with the current reducer.

### 5. Restore active-turn elapsed time after refresh

Today `turnStartRef` resets on refresh, so even if token metrics were persisted, active elapsed time still restarts from zero.

Use `thread.metrics.activeTurnStartedAt` when:

- the thread is `running`
- `turnStartRef.current` is empty after reload

That restores the live timer for mid-turn refreshes.

### 6. Keep WebSocket flow simple

No new WebSocket message type is required.

Current flow becomes:

```text
agent metrics delta
-> SessionManager persists thread metrics
-> live clients still receive normal stream_delta
-> refreshed client reloads thread list / thread_updated
-> client hydrates metrics from persisted thread state
```

This keeps stream deltas fast and ephemeral while giving refreshes a stable baseline.

## Files

### Server

- `server/src/db/index.ts`
- `server/src/sessions/manager.ts`
- `server/src/routes/threads.ts` if thread serialization needs touch-up

### Shared

- `shared/src/types.ts`

### Client

- `client/src/App.tsx`
- `client/src/components/StickyRunBar.tsx` only if prop/shape adjustments are needed

## Edge Cases

- **Refresh mid-turn before any metrics delta:** show elapsed time from `activeTurnStartedAt`, but no usage bar until the first usage delta arrives.
- **Refresh after completed turn:** show full session summary and last-turn usage immediately.
- **Old rows with no metrics:** default to zeros/nulls; bar behaves as it does today.
- **New turn starts after a previous heavy turn:** reset latest token snapshot at turn start so the new turn does not briefly show stale usage.
- **Thread status changes while disconnected:** persisted metrics still rehydrate correctly on reconnect.

## Tests

1. DB migration test for the new thread metric columns.
2. `SessionManager` test that metrics deltas persist the latest snapshot.
3. `SessionManager` test that final metrics increment totals exactly once.
4. Client hydration test that a thread with persisted metrics renders a non-empty StickyRunBar after refresh.
5. Client test that active elapsed time uses `activeTurnStartedAt` after reload.
6. Regression test that metrics persistence does not reorder threads by `updated_at`.

## Rollout Notes

- Migrate columns with safe defaults so existing databases continue working.
- Ship thread metrics first, then client hydration.
- If desired later, add a separate `thread_turn_metrics` table for history, but do not block this refresh fix on that.

## Recommendation

Persist the StickyRunBar read model on `threads`, hydrate it through existing thread APIs, and continue using live stream deltas for in-turn updates. That fixes refresh with minimal architectural churn.
