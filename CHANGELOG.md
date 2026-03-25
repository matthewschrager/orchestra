# Changelog

## [0.1.11.0] - 2026-03-24

### Changed

- **Project-scoped slash command autocompletion** — commands endpoint now reads `installed_plugins.json` and `settings.json` (global + project-level) to filter slash commands to only installed & enabled plugins; `.agents/` internal skill directories are excluded; client refetches commands on project switch with stale-response guard

### Added

- **Command discovery tests** — 23 new tests covering settings reading, plugin path resolution, enabledPlugins merge logic, `.agents/` exclusion, deduplication, route caching, and project-scoped lookups

## [0.1.10.2] - 2026-03-25

### Fixed

- **Cross-client thread sync** — threads created or archived on one device (mobile/desktop) now appear/disappear on all connected clients in real-time via WebSocket broadcast, without requiring a page refresh
- **Duplicate thread race condition** — guarded against the creating client seeing a duplicate sidebar entry when the WS broadcast arrives before the HTTP response

## [0.1.10.1] - 2026-03-24

### Added

- **Worktree cleanup on thread archive** — when archiving a thread with a worktree, a confirm dialog asks whether to also delete the worktree and branch; cleanup failures surface as a warning instead of being silently swallowed
- **Thread archive route tests** — 5 new tests covering archive with/without worktree cleanup, cleanup failure handling, and 404 for missing threads

### Fixed

- **`waiting` status indicator in sidebar** — restored amber pulsing dot for threads awaiting user input (previously showed as generic gray dot)

## [0.1.10.0] - 2026-03-24

### Changed

- **CLI-to-SDK migration** — replaced CLI subprocess spawning (`claude -p --output-format stream-json`) with `@anthropic-ai/claude-agent-sdk` `query()` API; SDK manages subprocess lifecycle internally
- **Simplified session manager** — removed ~350 lines of process lifecycle code (readStream, collectStderr, handleExit, PID health checks, orphan process cleanup); replaced with async iterator consumption via `consumeStream()`
- **Rewritten agent interfaces** — `AgentProcess`/`SpawnOpts` replaced with `AgentSession`/`StartOpts`; parser now stateful per-session via `parseMessage()` on `AgentSession`

### Added

- **SDK error detection** — surfaces SDK error results (error subtypes, zero-turn successes) as visible error messages instead of silent completion
- **Inactivity timeout** — 5-minute watchdog replaces PID-based health check for hung SDK iterators
- **AbortController cancellation** — `aborted` flag distinguishes user-initiated stops from SDK errors
- **Debug logging** — gated behind `ORCHESTRA_DEBUG=1` for diagnosing SDK issues
- **User/project settings loading** — `settingSources: ["user", "project", "local"]` ensures CLI skills and plugins are available through the SDK

### Fixed

- **Slash command handling in SDK** — `/autoplan` and other skills now work correctly by loading user settings (previously returned "Unknown skill" silently)
- **Tool use deduplication** — stream_event and assistant events for the same tool_use_id no longer produce duplicate messages

## [0.1.9.1] - 2026-03-24

### Fixed

- **WorktreePathInput missing import in App.tsx** — clicking the "Isolate worktree" checkbox threw `ReferenceError: WorktreePathInput is not defined` because the component was used but never imported

## [0.1.9.0] - 2026-03-24

### Changed

- **Unified spinner indicators** — replaced pulsing green dots and equalizer bars with a consistent spinning circle across sidebar, chat, and status bar
- **Idle threads show no indicator** — done/paused threads no longer display status dots in sidebars; only running/pending/waiting/error states show indicators
- **Removed cost display** — removed `$` cost from both idle session summary and active metrics strip in StickyRunBar

### Added

- **Cursor-aware slash command autocomplete** — typing `/` anywhere in the input (not just at the start) triggers command autocomplete with mid-text token replacement and highlighting
- **Slash command input tests** — 19 unit tests for `findSlashToken`, `buildHighlightSegments`, and `replaceSlashToken` pure functions

### Removed

- **Equalizer animation** — removed unused `animate-eq` CSS keyframes and custom property
- **Header spinner** — removed spinning indicator next to "Orchestra" title

## [0.1.8.0] - 2026-03-24

### Fixed

- **Remove 30s stall timer** — killed agent processes during long operations (thinking, tool calls). Processes in `-p` mode exit on their own; the timer was always counterproductive
- **Deduplicate turn_end signal** — only the `result` event emits `turn_end` (with session_id), preventing a race where the client saw "turn ended" before session_id was captured
- **Attention continuationToken fallback** — falls back to DB-persisted session_id when in-memory value is null (first-turn race)
- **Skip buffer flush for superseded processes** — killed processes no longer persist truncated JSON as assistant messages
- **Health check races with handleExit** — health check now skips threads with pending stream drain, preventing clean exits from being marked as errors
- **Recovery TOCTOU** — `isAgentProcess` check runs before `getParentPid` to guard against PID recycling
- **Port hash collision space** — expanded worktree port hash from 999 to 9999 slots; EADDRINUSE error now explains worktree collision
- **Archived projects reappear after restart** — restored `archived_at IS NULL` filter in `backfillProjects()` (accidental revert)

### Added

- **AskUserQuestion inline rendering** — agent questions render as interactive cards in chat with answer buttons instead of raw tool JSON
- **WebSocket heartbeat** — client sends periodic pings to prevent idle disconnection
- **Stream drain timeout with cancel** — Bun's ReadableStream gets cancelled after 2s timeout on process exit, with line buffer flush for any remaining data
- **message_stop regression test** — verifies `message_stop` returns empty deltas

### Changed

- **Claude parser rewrite** — event handling extracted into focused methods (`handleTextDelta`, `handleToolUse`, `handleResult`, etc.) with proper tool input finalization from streamed JSON deltas
- **Thread updates broadcast to all WS clients** — enables cross-thread status updates for attention inbox
- **Worktree detection** — `detectWorktree` returns the worktree name (not just boolean) for port/data isolation

### Removed

- **TodoRenderer** — removed in favor of native task list rendering
- **WorktreePathInput** — simplified worktree UI

## [0.1.7.1] - 2026-03-23

### Fixed

- **Archived projects reappear after restart** — `backfillProjects()` now excludes archived threads (`archived_at IS NULL`) so deleting a project no longer causes it to be recreated on next server start

## [0.1.7.0] - 2026-03-23

### Added

- **TodoWrite rich renderer** — Claude's task lists now render as visual checklists in chat (status icons: ✓ done, ▸ active, ○ pending) instead of raw JSON blobs
- **StickyRunBar task progress** — Real-time "N/M tasks" counter in the status bar while agent is working, derived from the latest TodoWrite state per thread
- **TodoItem shared type** — `TodoItem` and `TodoStatus` types in shared module for cross-package consistency
- **WorktreePathInput component** — Text input with inline directory browser for selecting worktree parent directories, used in all three worktree input locations
- **Spinning status indicator** — Header shows a spinning accent circle when agent is actively working, no icon when idle (replaces static blue dot)

### Fixed

- **Mobile overlays hidden behind header** — Tab overlays (Inbox, Sessions, New) now position within the main content area using absolute positioning instead of viewport-fixed, so they start below the header bar
- **Worktree input missing on mobile** — Mobile new session form now shows the worktree name input with directory browser when "Isolate to worktree" is checked
- **IME composition regression** — Enter-to-send now skips during IME composition (CJK input methods) to prevent accidental submission
- **Safe-area padding on mobile overlays** — Restored `env(safe-area-inset-bottom)` so content isn't clipped behind the home indicator on iOS devices
- **Stale worktree name on project switch** — Worktree name now regenerates when switching projects in mobile new session form

### Changed

- **Tool dispatch expanded** — `getRichRenderer()`, `TOOL_VERBS`, `ToolIcon`, and `extractToolContext` updated to handle TodoWrite tool calls
- **TodoWrite grouping** — Each TodoWrite gets its own visual group in the chat (like AskUserQuestion) since each call replaces the full task list
- **Enter sends, Shift+Enter for newline** — Textarea keybinding changed from Cmd/Ctrl+Enter to Enter for sending messages
- **Worktree default path** — Worktrees now default to `orchestra/` subdirectory (e.g., `orchestra/project-abc123`) for organization
- **Absolute path support in WorktreeManager** — Server accepts both relative names and absolute paths from the directory picker

## [0.1.6.0] - 2026-03-23

### Fixed

- **Remove 30s stall timer** — The stall timer killed agent processes after 30 seconds of no stdout, causing sessions to die during long operations (thinking, tool calls). Processes in `-p` mode exit on their own; no timer needed.
- **Deduplicate turn_end signal** — `message_stop` stream event no longer emits a bare `turn_end`; only the `result` event does (with session_id attached), preventing a race where the client saw "turn ended" before the session_id was captured for `--resume`.
- **Attention continuationToken fallback** — Attention items now fall back to the DB-persisted session_id when the in-memory value is null (first-turn race).
- **Skip buffer flush for superseded processes** — Killed processes no longer persist truncated JSON as assistant messages in the transcript.

### Added

- **Regression test** — `message_stop` stream event verified to return empty deltas (prevents re-introduction of the dual turn_end bug)

## [0.1.5.0] - 2026-03-23

### Added

- **Attention queue** — Durable `attention_required` table persists agent questions and permission requests across reconnects, with TTL expiry, orphan cleanup, and idempotent resolution
- **AskUserQuestion detection** — Claude adapter detects AskUserQuestion tool calls and `permission_denials` in stream-json, extracting full question/options payload
- **Session manager attention lifecycle** — Persists attention events, sets thread status to "waiting", 30-second stall detection, `resolveAndResume()` re-spawns agent via `--resume`
- **Session ID persistence** — `session_id` column on threads table, survives server restart
- **WebSocket attention protocol** — `attention_required`/`attention_resolved` events broadcast to ALL clients (cross-thread inbox), `resolve_attention` client action, pending attention replay on subscribe
- **REST attention API** — `GET /api/attention` (list pending), `POST /api/attention/:id/resolve` (idempotent, first-caller-wins with race condition guard)
- **Cloudflare Tunnel** — `TunnelManager` spawns cloudflared, captures URL; `--tunnel` flag forces auth on all requests including localhost (prevents tunnel auth bypass)
- **Push notifications** — VAPID key management, Web Push dispatch, subscription CRUD, service worker with action buttons + deep-linking + notification-click client handler
- **Mobile UI** — Bottom tab navigation (Inbox/Sessions/New) with attention badge, `AttentionInbox` with question/permission/confirmation cards, `MobileSessions` thread list, `MobileNewSession` form
- **`useAttention` hook** — Cross-thread attention state from REST API initial sync + WebSocket live updates
- **`usePushNotifications` hook** — VAPID subscription, permission management, IndexedDB token storage
- **Attention expiry** — Hourly `expireAttentionItems()` sweep + startup cleanup
- **10 attention queue tests** — CRUD, idempotent resolution, orphan cleanup, expiry, API conversion

### Fixed

- **Tunnel auth bypass** — `--tunnel` now forces auth on both HTTP middleware and WebSocket handler (cloudflared traffic appears local)
- **Cross-thread attention broadcast** — Attention events now reach all connected WS clients, not just thread-subscribed ones
- **Resolution race condition** — Double-resolution from multiple clients no longer spawns duplicate agent processes (first-caller-wins guard)
- **REST resolution broadcast** — Resolving via REST API now notifies WS clients via `onAttentionResolved` listener
- **stopThread cleanup** — Orphans attention items + clears stall timer when thread is stopped
- **Post-restart recovery** — Orphans attention items for recovered waiting/running threads
- **AttentionCard submit guard** — Permission cards no longer permanently disable on accidental Enter key

### Changed

- **ThreadStatus** — Added `"waiting"` status, included in active thread count and recovery queries
- **ParseResult** — Extended with optional `attention` field for `AttentionEvent` detection
- **WSClientMessage/WSServerMessage** — Extended with attention event types

## [0.1.3.0] - 2026-03-23

### Added

- **Directory browser** — Add Project dialog now includes a visual filesystem browser with git repo detection, replacing the raw path input
- **Error message tracking** — Thread errors now store and display stderr output; error banners show in chat view and tooltips on status badges
- **WebSocket error handling** — Client now surfaces server-side WebSocket errors via `onError` callback
- **Filesystem API** — New `/api/fs/browse` endpoint for directory listing with git repo detection
- **Stderr collection** — Session manager captures subprocess stderr (capped at 4KB) for error reporting
- **7 filesystem route tests** — Covers directory listing, sorting, hidden file exclusion, git detection, parent path, and error cases

### Fixed

- **start.sh port cleanup** — SIGTERM → poll → SIGKILL escalation with final port check prevents "port in use" errors
- **Phantom system messages** — Null/empty system events no longer create empty assistant message bubbles
- **Empty message filtering** — MessageBubble skips rendering empty or `""` content
- **Stream event noise** — `message_start` and `message_delta` envelope events are silently handled instead of logged as unknown

### Changed

- **Stop button redesign** — Replaced full-width "Stop running" banner with compact animated stop icon next to the input
- **Concurrent threads** — Removed per-project main worktree mutex; multiple threads can run on the same project simultaneously
- **Turn-aware UI state** — Pulse animation and StickyRunBar use `activelyWorking` (running + turn not ended) instead of raw `isRunning`
- **Orphan thread recovery** — Server restart marks orphaned running threads with descriptive error messages

## [0.1.2.0] - 2026-03-23

### Added

- **Rich tool renderers** — Edit diffs render as inline diffs with +/- lines and change counts; Bash output shows formatted terminal blocks with exit code badges and highlighted pass/fail lines; File reads display syntax-highlighted content via Shiki with line numbers; Search results show matched files/lines with highlighted terms
- **Sub-agent visibility** — Agent tool calls render as lightweight status cards with running/done/error states and extracted descriptions
- **Sticky run bar** — Persistent strip between chat and input showing current action, elapsed time, cost, and an Interrupt button; collapses to session summary when idle
- **Streaming state reducer** — Replaced 6 separate `Map` state variables with a single `useReducer` for cleaner streaming state management
- **Cost/duration tracking** — Server extracts `cost_usd` and `duration_ms` from Claude's `result` events and forwards as `metrics` stream deltas
- **Unknown event logging** — Stream events that hit the `default` case now log to `console.warn` instead of being silently dropped
- **DOMPurify sanitization** — Shiki's HTML output is sanitized before rendering via `dangerouslySetInnerHTML`
- **Slash command input** — Text input with slash command autocomplete dropdown
- **Project removal** — Remove projects from the sidebar with confirmation dialog
- **38 unit tests** — Parser tests for all 5 renderers plus server-side cost extraction tests

### Fixed

- **Phantom "Thinking..." indicator** — Added `turnEnded` flag to streaming state so the thinking indicator disappears immediately when Claude's turn ends, rather than persisting until the process exits

### Changed

- **Design system polish** — Migrated from hardcoded Tailwind slate colors to semantic CSS custom properties (base, surface-1..5, edge-1..2, content-1..3, accent)
- **Frosted glass header** — Top bar uses `backdrop-blur-xl` with semi-transparent background
- **System event surfacing** — Claude's `system` events now render as assistant messages instead of being dropped

## [0.1.1.0] - 2026-03-23

### Added

- **Multi-project support** — Register multiple git repos as projects, manage threads across them from a single Orchestra instance
- **Project-centric sidebar** — Codex-style two-level sidebar with projects as top-level items and threads nested under each, replacing the flat thread list
- **Project CRUD** — REST API for registering, renaming, and deleting projects with git repo validation and path deduplication
- **CLI `orchestra add`** — Register projects from the terminal with shared validation logic
- **Real-time streaming** — Claude's text output and tool calls stream to the UI as they happen, replacing the static "Thinking..." placeholder
- **Stream delta pipeline** — Ephemeral WebSocket channel for streaming deltas (text, tool_start, tool_input, tool_end) without DB persistence
- **Project-aware thread creation** — EmptyState shows repo name, branch, and path so the user knows exactly where work will happen
- **Welcome state** — First-launch experience with "Add project" CTA and CLI instructions
- **Add Project dialog** — Path input with validation and error display
- **Per-project worktree lock** — Two threads in different projects can run simultaneously on their respective main worktrees
- **Tool context display** — Streaming tool calls show the tool name plus extracted context (file path, command, pattern)
- **Thread archiving** — Archive threads from the sidebar with hover-revealed archive button
- **DB migration** — Auto-creates projects from existing threads' repo_path on upgrade, with path normalization and deduplication

### Changed

- **Spawn model** — Switched from long-lived interactive stdin pipe to `-p` one-shot mode with `--resume` for multi-turn. Fixes Bun pipe buffering issue where Claude's output never arrived.
- **`--include-partial-messages`** — Added to Claude spawn args to enable `stream_event` real-time deltas
- **Thread creation requires `projectId`** — API now validates project existence and resolves path from the project record

### Fixed

- **Duplicate final messages** — `result` event no longer persists text (already captured by `assistant` event), eliminating duplicate response messages
- **Session ID persistence** — Session ID now survives process exit for `--resume` continuity across turns
- **Superseded process safety** — `handleExit` and `readStream` check PID to avoid tearing down a new session when an old process exits
- **False `tool_end` for text blocks** — `content_block_stop` now tracks current block type and only emits `tool_end` for tool_use blocks
- **FK constraint on project delete** — Nulls out `project_id` on threads before deleting the project row
- **Session ID leak** — `turn_end` delta text (containing session_id) is stripped before forwarding to WebSocket clients

## [0.1.0.0] - 2026-03-22

### Added

- **Thread-based agent management** — Start, stop, and manage CLI agent sessions as threads with streaming output
- **Claude Code adapter** — Spawn Claude Code with `--output-format stream-json`, parse streaming output, handle stdin/lifecycle
- **Session manager** — Process lifecycle management with WebSocket bridge, SQLite persistence, and main worktree mutex
- **Git worktree isolation** — One-click isolation of a thread into its own worktree with branch management
- **PR creation** — Create PRs directly from worktree threads via `gh` with commit, push, and PR in one flow
- **Web frontend** — React + Tailwind SPA with thread sidebar, streaming chat view, collapsible tool blocks, and context panel
- **Token auth** — Bearer token authentication for secure remote access, localhost bypass, auth gate UI
- **Mobile responsive** — Bottom sheet context panel, safe-area insets, touch-friendly targets, PWA manifest
- **CLI entry point** — `orchestra serve`, `orchestra auth show/regenerate`, `orchestra help`
- **SQLite persistence** — Threads, messages, and agent configs with WAL mode and atomic seq assignment

### Fixed

- Atomic message sequence numbering (race condition prevention)
- Constant-time token comparison (timing attack prevention)
- Auth fails closed on unknown IP (was fail-open)
- SPA fallback properly awaits file read
- Git command stderr collected concurrently (reliable error messages)
- Commit exit code checked in PR creation flow
- repoPath validated as git repository before use
