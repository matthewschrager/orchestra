# Changelog

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
