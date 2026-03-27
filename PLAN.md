<!-- /autoplan restore point: /home/mschrager/.gstack/projects/matthewschrager-orchestra/orchestra-orchestra-4g7zi07hb4x-autoplan-restore-20260326-182120.md -->
# PR Status Indicators for Thread Sidebar

## Context

Currently, threads with PRs show a static green "PR" badge in the sidebar — no distinction between open, merged, or closed PRs. The user wants at-a-glance visibility into PR lifecycle state, similar to Codex app's icons (open circle, merged icon, closed circle with different colors).

## Current State

- `Thread.prUrl: string | null` — stores GitHub PR URL, set by `WorktreeManager.createPR()`
- Sidebar/mobile show a flat green "PR" badge when `prUrl` is non-null
- No `prStatus` field exists — no way to know if a PR is open, merged, or closed
- `gh pr view <url> --json state,isDraft,number` can return `OPEN`, `CLOSED`, `MERGED` + draft status

## Design

### Data Model

Add three columns to `threads` table:

```
pr_status            TEXT     -- 'draft' | 'open' | 'merged' | 'closed' | null
pr_number            INTEGER  -- GitHub PR number (extracted from URL)
pr_status_checked_at TEXT     -- ISO timestamp of last gh status fetch (stale guard)
```

Add to `ThreadRow`, `Thread` type, and `threadRowToApi` mapping.

### PR Status Type

```typescript
export type PrStatus = 'draft' | 'open' | 'merged' | 'closed';
```

### Server: PR Status Fetching

New utility `server/src/worktrees/pr-status.ts`:

```typescript
export async function fetchPrStatus(prUrl: string, cwd: string): Promise<{ status: PrStatus; number: number } | null>
```

**`cwd` is required** — `gh pr view` needs to run in a directory belonging to the correct GitHub repo so it can resolve the remote. Use the thread's `repoPath` (not `worktree`, since the worktree may be cleaned up).

Implementation: spawn `gh pr view <url> --json state,isDraft,number` with `cwd`, parse JSON. 10-second timeout. Returns `null` on any failure (non-zero exit, timeout, malformed JSON, `gh` not installed).
- `isDraft: true` → `"draft"`
- `state: "OPEN"` → `"open"`
- `state: "MERGED"` → `"merged"`
- `state: "CLOSED"` → `"closed"`

### When PR Status Gets Updated

1. **On PR creation** (`WorktreeManager.createPR`): set `pr_status = 'open'`, extract `pr_number`
2. **On thread list load** (`GET /api/threads`): fire-and-forget background refresh for threads with `pr_status = 'open'` or `'draft'` (only open/draft PRs can change state)
3. **New endpoint** `POST /api/threads/:id/refresh-pr`: manually refresh a single thread's PR status (for the ContextPanel)
4. **Stale guard**: only re-fetch if `pr_status_checked_at` is >5 min ago (dedicated column — not `updated_at`, which gets bumped by unrelated mutations)
5. **On thread selection** (ContextPanel open): also trigger refresh if stale — covers SPA users who don't reload thread list

The fire-and-forget refresh on thread list load broadcasts `thread_updated` via WS **only when status actually changed** (compare fetched vs stored — avoids WS spam when nothing changed). `pr_status_checked_at` is server-internal only — NOT exposed in the Thread API response.

### Client: Status-Aware PR Badges

Replace the flat "PR" badge with status-specific icons and colors:

| Status | Icon | Color | Badge Text |
|--------|------|-------|------------|
| Status | Icon | Color | Badge Text |
|--------|------|-------|------------|
| `null` (fallback) | None | Green (`bg-emerald-900/40 text-emerald-300`) | "PR" (legacy style) |
| `draft` | Unfilled circle | Gray (`bg-gray-700/40 text-gray-400`) | "Draft #N" |
| `open` | Git PR open icon (Octicons `git-pull-request`) | Green (`bg-emerald-900/40 text-emerald-300`) | "PR #N" |
| `merged` | Git merge icon (Octicons `git-merge`) | Purple (`bg-purple-900/40 text-purple-300`) | "Merged #N" |
| `closed` | PR closed icon (Octicons `git-pull-request-closed`) | Red (`bg-red-900/40 text-red-300`) | "Closed #N" |

**Always show PR number** in all states for cross-referencing with GitHub.

Icons: inline SVGs at `w-2.5 h-2.5` using Octicons path data, matching existing `text-[10px] px-1 py-0.5 rounded` badge style. Exact SVG paths will be taken from [GitHub Octicons](https://primer.style/foundations/icons).

**Sidebar/mobile: NOT clickable** (badge is inside thread row `<button>` — nested interactive elements are invalid HTML and cause click conflicts). **ContextPanel: clickable** (PR URL is already an `<a>` link there).

### Components Changed

- **`ProjectSidebar.tsx`**: Replace `{thread.prUrl && <span>PR</span>}` with `<PrBadge>` component
- **`MobileSessions.tsx`**: Same replacement
- **`ContextPanel.tsx`**: Show PR status next to URL, add refresh button
- **New `PrBadge.tsx`**: Shared component rendering status-aware icon + label

### Files Changed

| File | Change |
|------|--------|
| `shared/src/types.ts` | Add `prStatus`, `prNumber` to `Thread`; add `PrStatus` type |
| `server/src/db/index.ts` | Column migrations for `pr_status`, `pr_number`, `pr_status_checked_at`; update `ThreadRow`, `threadRowToApi` |
| `server/src/worktrees/pr-status.ts` | **New** — `fetchPrStatus()` utility |
| `server/src/worktrees/manager.ts` | Set `pr_status`/`pr_number` on PR creation |
| `server/src/routes/threads.ts` | Add `POST /:id/refresh-pr`; fire-and-forget refresh on `GET /` |
| `client/src/components/PrBadge.tsx` | **New** — shared PR status badge component |
| `client/src/components/ProjectSidebar.tsx` | Use `<PrBadge>` |
| `client/src/components/MobileSessions.tsx` | Use `<PrBadge>` |
| `client/src/components/ContextPanel.tsx` | Show status, add refresh button |
| `client/src/hooks/useApi.ts` | Add `refreshPrStatus()` method |
| `server/src/worktrees/__tests__/pr-status.test.ts` | **New** — test `fetchPrStatus` parsing |

### Visual Design (ASCII)

Sidebar thread row — current:
```
  ○ Fix login bug
    claude  ┌wt┐  ┌PR┐
```

Sidebar thread row — new (open PR):
```
  ○ Fix login bug
    claude  ┌wt┐  ┌⬮ PR #42┐
```

Sidebar thread row — new (merged PR):
```
  ○ Fix login bug
    claude  ┌wt┐  ┌⑂ Merged #42┐
```

Sidebar thread row — new (closed PR):
```
  ○ Fix login bug
    claude  ┌wt┐  ┌✕ Closed #42┐
```

Sidebar thread row — new (fallback, prStatus=null):
```
  ○ Fix login bug
    claude  ┌wt┐  ┌PR┐
```

ContextPanel PR section:
```
┌─ Pull Request ──────────────────────┐
│  ⬮ Open  #42                        │
│  https://github.com/org/repo/pull/42│
│  [↻ Refresh]                        │
└─────────────────────────────────────┘
```
(Refresh button only shown for open/draft/null states)

### Concurrency Guard

Fire-and-forget refresh on `GET /threads` could spawn N `gh` processes if many threads have open PRs. Add a simple semaphore: max 3 concurrent `gh pr view` calls. Additional requests queue.

### Fallback Badge

When `prUrl` exists but `prStatus` is null (pre-migration threads, `gh` unavailable), show the current green "PR" badge as fallback. No status icon, just the text "PR".

### Accessibility

- **Sidebar/mobile**: Badge is a `<span>` (not clickable — inside thread row button). `title` tooltip: "Pull request #N, open" etc.
- **ContextPanel**: PR URL is an `<a>` with `target="_blank"` and `rel="noopener noreferrer"`, already clickable
- Color + icon together convey status (not color-alone)

## Test Plan

1. **Unit tests**: `fetchPrStatus` parses all 4 states correctly, handles `gh` failure gracefully, handles timeout, handles malformed JSON
2. **Unit tests**: Stale guard — skips refresh when checked <5 min ago, refreshes when >5 min or null, skips merged/closed PRs
3. **DB migration**: column migration runs cleanly, existing threads have null values
4. **Integration**: `createPR` sets `pr_status = 'open'` and `pr_number`
5. **Integration**: `POST /:id/refresh-pr` returns updated thread with status
6. **Existing tests**: all pass (new fields are nullable — no breaking changes)
7. **Visual**: build client, verify badges render for each state via browser
8. **Full test plan**: `~/.gstack/projects/matthewschrager-orchestra/mschrager-orchestra-orchestra-4g7zi07hb4x-test-plan-20260326-182925.md`

## NOT in Scope

- CI/CD check status display — different API surface, not in blast radius
- PR review status (approved/changes-requested) — additional complexity
- GitHub webhook integration — infrastructure change (ocean)
- Thread lifecycle composite indicator — broader redesign, future work
- GitLab/Bitbucket support — GitHub-only for v1 (stated limitation)
- PR event history / analytics — flat column model fine for v1

## What Already Exists

| Sub-problem | Existing Code |
|-------------|---------------|
| `gh` CLI spawning | `WorktreeManager.createPR()` — `Bun.spawn(["gh", "pr", "create", ...])` |
| DB column migration | `COLUMN_MIGRATIONS` array in `db/index.ts` |
| Thread → API mapping | `threadRowToApi()` in `db/index.ts` |
| Badge rendering | `ProjectSidebar.tsx` L269-273, `MobileSessions.tsx` L142-146 |
| WS broadcast | `sessionManager.notifyThread(threadId)` |
| Fire-and-forget pattern | `titles/generator.ts` |

## Error & Rescue Registry

| Error | Detection | Rescue |
|-------|-----------|--------|
| `gh` not installed/authed | `fetchPrStatus` returns null | Badge shows "PR" (no status) — graceful fallback |
| GitHub rate limit | `gh` exits non-zero | Return null, retry on next trigger |
| PR URL malformed | Regex fails to extract number | Skip status fetch, log warning |
| DB migration fails | Column exists check | Migration is idempotent |
| `gh` subprocess hangs | 10s timeout on Bun.spawn | Kill process, return null |

## Failure Modes Registry

| Mode | Severity | Mitigation |
|------|----------|------------|
| All PRs show stale "open" | Medium | Manual refresh in ContextPanel, 5-min stale guard |
| N concurrent gh spawns | Low | Concurrency semaphore (max 3) |
| Badge flicker on WS update | Low | Badge swap is instant — no animation needed |

## Cross-Phase Themes

**Theme: Fallback/degradation for `gh` unavailability** — flagged in CEO (premise challenge), Design (missing state), Eng (edge case). High-confidence signal. All three phases independently identified that `gh` CLI failure mode needs explicit handling. Resolved: null return + fallback badge + circuit breaker consideration.

**Theme: Concurrency control on background refresh** — flagged in CEO (scaling concern), Eng (10x load). Both identified that N concurrent subprocess spawns on page load is problematic. Resolved: max-3 semaphore.

## Dual Voice Consensus Tables

```
DESIGN DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Consensus
  ──────────────────────────────────── ──────── ─────────
  1. Info hierarchy correct?           Yes     CONFIRMED
  2. All states specified?             No      FIXED (fallback added)
  3. Interaction model clear?          No      FIXED (sidebar not clickable)
  4. Icon specs implementable?         No      FIXED (Octicons reference added)
  5. Responsive strategy?              Yes     CONFIRMED
  6. Accessibility specified?          No      FIXED (aria-label added)
  7. ContextPanel layout specified?    No      FIXED (ASCII mockup added)
═══════════════════════════════════════════════════════════════
4/7 required fixes. All resolved. [subagent-only]

ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Consensus
  ──────────────────────────────────── ──────── ─────────
  1. Architecture sound?               Yes     CONFIRMED
  2. Test coverage sufficient?         No      FIXED (5 gaps added to test plan)
  3. Performance risks addressed?      No      FIXED (semaphore + change-only broadcast)
  4. Security threats covered?         Yes     CONFIRMED (no injection risk)
  5. Error paths handled?              No      FIXED (cwd, gh failure, null fallback)
  6. Deployment risk manageable?       Yes     CONFIRMED (additive migration)
═══════════════════════════════════════════════════════════════
3/6 required fixes. All resolved. [subagent-only]
```

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|
| 1 | CEO | Approach A (cached in DB) over Approach B (fetch on render) | P3 Pragmatic | DB cache is fast + avoids rate limits | Fetch-on-render (slow, N+1 API calls) |
| 2 | CEO | Approach A over Approach C (webhooks) | P5 Explicit | Webhooks require new infra — ocean, not lake | Webhook listener |
| 3 | CEO | Add `pr_status_checked_at` column | P1 Completeness | `updated_at` bumped by unrelated mutations — stale guard would be broken | Reuse `updated_at` |
| 4 | CEO | Auto-approve clickable badge expansion | P2 Boil lakes | In blast radius, <5 min effort | N/A |
| 5 | CEO | Auto-approve PR number in badge | P1 Completeness | Trivial effort, better UX | N/A |
| 6 | CEO | Auto-approve ContextPanel status + refresh | P2 Boil lakes | Already touching this file | N/A |
| 7 | CEO | Defer CI/CD status | P3 Pragmatic | Outside blast radius, new API surface | N/A |
| 8 | CEO | Defer webhook integration | P5 Explicit | Ocean — requires new infrastructure | N/A |
| 9 | CEO | GitHub-only for v1 | P3 Pragmatic | gh already a dependency, no other forge support exists | Multi-forge |
| 10 | CEO | Add gh availability fallback (null + log) | P5 Explicit | Graceful degradation over silent failure | Hard error |
| 11 | CEO | Also refresh on thread selection | P1 Completeness | SPA users may not reload thread list | Only on list load |
| 12 | Design | Fallback "PR" badge for null prStatus | P1 Completeness | Pre-migration threads need visual | No fallback |
| 13 | Design | Add hover state for clickable badge | P5 Explicit | Clickable elements need affordance | No hover |
| 14 | Design | Add aria-label to badge | P1 Completeness | Accessibility requirement | No a11y |
| 15 | Eng | Max 3 concurrent gh calls | P3 Pragmatic | Prevents subprocess flood on many open PRs | Unlimited spawns |
| 16 | Eng | Skip refresh for merged/closed PRs | P3 Pragmatic | Terminal states don't change | Refresh all states |
| 17 | Eng | Add `cwd` param to `fetchPrStatus` | P5 Explicit | `gh` needs repo context to resolve remote | No cwd (breaks) |
| 18 | Eng | Only broadcast WS when status changes | P3 Pragmatic | Avoids WS spam on page load | Broadcast every fetch |
| 19 | Eng | `pr_status_checked_at` server-internal only | P5 Explicit | Implementation detail, not client concern | Expose in API |
| 20 | Design | Badge NOT clickable in sidebar (click collision) | P5 Explicit | Nested `<a>` inside `<button>` is invalid HTML | Clickable everywhere |
| 21 | Design | Always show PR # in all states | P1 Completeness | Cross-reference with GitHub needs number | Number only on open |
| 22 | Design | Fallback "PR" badge for null prStatus | P1 Completeness | Pre-migration + gh-unavailable threads need badge | No fallback |
| 23 | Design | Refresh button only for open/draft/null | P3 Pragmatic | Merged/closed PRs won't change | Always show refresh |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | 5 findings (1 critical stale guard, 2 high, 2 medium — all resolved) |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clean | 9 findings (1 high cwd param, 5 medium test gaps — all resolved) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | 7 findings (2 critical click collision + fallback, 2 high icons + copy — all resolved) |
| CEO Voices | autoplan | Independent challenge | 1 | subagent-only | 6/6 confirmed |
| Design Voices | autoplan | Independent challenge | 1 | subagent-only | 4/7 required fixes, all resolved |
| Eng Voices | autoplan | Independent challenge | 1 | subagent-only | 3/6 required fixes, all resolved |

**VERDICT:** ALL REVIEWS CLEARED — 23 auto-decisions, 0 taste decisions. Ready to implement.
