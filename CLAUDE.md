<!-- Keep AGENTS.md and CLAUDE.md identical -->

# Orchestra

Agent-first development interface — a local web/mobile UI that orchestrates agent sessions via the Claude Agent SDK.

## Project structure

```
orchestra/
├── server/          Bun + Hono backend
│   └── src/
│       ├── index.ts        Server entry point
│       ├── cli.ts          CLI entry point (serve, auth)
│       ├── auth.ts         Token auth for remote access
│       ├── db/index.ts     SQLite schema + helpers
│       ├── agents/         Agent adapter interface + implementations
│       │   ├── types.ts    AgentAdapter interface
│       │   ├── claude.ts   Claude Code adapter
│       │   ├── codex.ts    Codex adapter
│       │   └── registry.ts Agent registry
│       ├── sessions/       Session lifecycle management
│       │   └── manager.ts  SDK session orchestration, stream consumption, persistence
│       ├── worktrees/      Git worktree management
│       │   ├── manager.ts  Create, status, PR, cleanup
│       │   └── pr-status.ts PR status fetching via gh CLI
│       ├── utils/          Shared utilities
│       │   ├── git.ts      Git validation + branch detection
│       │   └── origins.ts  Shared allowed-origins helper (CORS/Origin/Host/WS)
│       ├── routes/         REST API routes
│       │   ├── projects.ts Project CRUD
│       │   ├── threads.ts  Thread CRUD + actions
│       │   ├── agents.ts   Agent listing
│       │   ├── commands.ts Slash command listing
│       │   ├── filesystem.ts Directory browser API
│       │   ├── attention.ts Attention queue API
│       │   ├── push.ts     Push subscription API
│       │   ├── uploads.ts  File upload + serve API
│       │   ├── files.ts    Local file proxy (image serving)
│       │   ├── settings.ts Settings CRUD API
│       │   └── tailscale.ts Tailscale status API
│       ├── push/           Web Push notification management
│       │   └── manager.ts  VAPID keys, subscriptions, dispatch
│       ├── tailscale/      Tailscale detection
│       │   └── detector.ts CLI detection, IP/hostname, serve config parsing
│       ├── titles/         AI title generation
│       │   └── generator.ts Fire-and-forget title gen via Agent SDK query()
│       ├── tunnel/         Cloudflare Tunnel integration
│       │   └── manager.ts  Tunnel lifecycle, URL capture
│       └── ws/handler.ts   WebSocket handler + attention events
├── client/          Vite + React + Tailwind frontend
│   └── src/
│       ├── App.tsx         Root component with auth gate + streaming reducer
│       ├── components/     UI components
│       │   ├── AuthGate.tsx       Token auth login screen
│       │   ├── ChatView.tsx      Chat messages + tool rendering
│       │   ├── ContextPanel.tsx  Thread context/worktree panel
│       │   ├── StickyRunBar.tsx  Real-time status + metrics strip
│       │   ├── PinnedTodoPanel.tsx Pinned TODO list above input (visible while agent works)
│       │   ├── InputBar.tsx      Message input with slash commands
│       │   ├── MarkdownContent.tsx Markdown rendering with Shiki highlighting
│       │   ├── ProjectSidebar.tsx Project/thread navigation
│       │   ├── TerminalPanel.tsx  xterm.js terminal panel
│       │   ├── WorktreePathInput.tsx Worktree root path selector
│       │   ├── OrchestraLogo.tsx  SVG logo component
│       │   └── renderers/        Rich tool output renderers
│       │       ├── DiffRenderer.tsx    Edit → inline diff
│       │       ├── BashRenderer.tsx    Bash → inline terminal preview
│       │       ├── ReadRenderer.tsx    Read → syntax-highlighted file
│       │       ├── SearchRenderer.tsx  Grep/Glob → match list
│       │       ├── SubAgentCard.tsx    Agent → status card
│       │       ├── TodoCard.tsx        TodoWrite → task checklist card
│       │       └── TodoRenderer.tsx    TodoWrite inline renderer
│       │   ├── AttentionInbox.tsx  Attention queue inbox
│       │   ├── SettingsPanel.tsx   Settings modal dialog
│       │   ├── RemoteAccessSettings.tsx Remote Access section (Tailscale detection + guided setup)
│       │   ├── MobileThreadHeader.tsx Mobile sticky header with back + editable title
│       │   ├── EditableTitle.tsx  Click-to-edit title (shared mobile/desktop)
│       │   ├── MobileNav.tsx      Bottom tab navigation
│       │   ├── MobileSessions.tsx Thread list for mobile
│       │   ├── MobileNewSession.tsx New session form for mobile
│       │   ├── SlashCommandInput.tsx Textarea with slash command autocomplete
│       │   ├── AttachmentPreview.tsx Thumbnail previews for file attachments
│       │   ├── FilePathLink.tsx  Clickable file path (vscode:// local, copy remote)
│       │   ├── ImageLightbox.tsx Full-screen image overlay
│       │   └── PrBadge.tsx        PR status badge (draft/open/merged/closed)
│       ├── lib/             Shared utilities
│       │   ├── askUser.ts   AskUserQuestion parsing + inline rendering helpers
│       │   ├── auth.ts      Auth token storage + validation
│       │   ├── asciiArt.ts  ASCII art logo for terminal display
│       │   └── fileUtils.ts isImageFile, shortenPath, fileServeUrl utilities
│       └── hooks/          useWebSocket, useApi, useAttention, usePushNotifications, useTerminal
└── shared/          Shared TypeScript types
```

## Commands

```bash
bun install                     # Install deps
bun run dev:server              # Dev server with watch
bun run dev:client              # Vite dev server with HMR
cd client && bun run build      # Build frontend to server/static/
cd server && bun run src/index.ts  # Production server
```

## Key design decisions

- Agents use `@anthropic-ai/claude-agent-sdk` (pinned v0.2.81) — SDK manages subprocess lifecycle internally
- **Persistent sessions**: Claude Code sessions use a long-lived `Query` object per thread — subprocess stays alive between turns, follow-ups injected via `streamInput()`. Eliminates MCP reconnection delay on follow-up messages. State machine: `thinking → idle/waiting → thinking`. Falls back to legacy `resume` path if subprocess crashes.
- **Message queuing**: Users can send messages while the agent is working (state `"thinking"`). Messages are persisted immediately and injected into the CLI subprocess via `streamInput()` with `priority: 'next'` (SDK passthrough to CLI's internal queue). Queue depth limit: 5 messages per turn. `queuedCount` tracked on `ActiveSession`, reset on `turn_end`. `queued_message` stream delta emitted from `sendMessage()` (not parser). Non-persistent adapters (Codex) keep current blocking behavior. `interrupt` boolean accepted in WS/REST API but ignored in Phase 1 (no-op). InputBar always enabled — Send + Stop shown side-by-side during active runs. StickyRunBar shows "· N queued" when messages pending.
- Legacy sessions (non-persistent adapters): `query()` with `resume` per turn
- SDK options: `permissionMode: "bypassPermissions"`, `cwd` per-call for multi-project isolation
- Multi-project: single server manages multiple registered git repos via `projects` table
- Multiple threads can run concurrently on the same project's main worktree
- Real-time streaming via ephemeral WebSocket deltas (not persisted to DB)
- Complete messages persisted to SQLite with WAL mode, seq-based replay on reconnect
- Token auth enforced for non-localhost requests (and always when `--tunnel` is active)
- Security hardening: CORS restricted to known origins via shared `getAllowedOrigins()` helper (`utils/origins.ts`); Origin header validation on mutations (CSRF); Host header validation with Tailscale support (DNS rebinding); WebSocket Origin check on upgrade (CORS doesn't protect WS); CSP + X-Frame-Options + nosniff + Referrer-Policy headers; filesystem browse restricted to `$HOME` with `realpathSync` + trailing-slash prefix collision fix; SQL column allowlists on `updateProject`/`updateThread`; per-client WS rate limiting (60/10s sliding window); attachment extension + MIME type control-char sanitization; SW targetUrl same-origin validation; DOMPurify on MarkdownContent Shiki output
- Rich tool renderers parse stream-json tool data into visual components (diffs, inline Bash previews, search results); special tools (AskUser, Agent, TodoWrite) registered in declarative `TOOL_RENDERERS` map
- TodoWrite rendering: latest TodoWrite renders as prominent card with all tasks, per-task status (✓ completed/▸ running/○ queued), progress bar, ARIA roles; prior TodoWrites collapse to expandable summary lines; `parseTodos()` normalizes both Claude SDK `{todos}` and Codex `{items}` shapes; `latestTodos` hydrated from REST history with streaming race guard
- Pinned TODO panel: `PinnedTodoPanel` component sits between StickyRunBar and InputBar; visible while agent is actively working (`isRunning && !turnEnded`) and `activeTodos` exist; collapsible via chevron toggle; header shows task icon + progress counter + inline progress bar; auto-hides when turn ends; CSS: `pinned-todo-panel` with subtle accent background + top border
- Shiki syntax highlighting lazy-loaded via shared module-level singleton (`lib/shiki.ts`) with DOMPurify sanitization; ReadRenderer uses `codeToHtml`, DiffRenderer uses `codeToTokens` (per-line control for diff backgrounds)
- DiffRenderer: Myers LCS diff algorithm (`lib/diffCompute.ts`) with line numbers, syntax highlighting, context lines; empty-string guards, trailing newline normalization, 500-line bail-out, 100-line outer truncation; mobile hides line numbers <640px; fallback semantic colors when Shiki unavailable
- Streaming state managed via useReducer with turnEnded flag to prevent phantom "Thinking..." indicators
- Cost/duration/token metrics extracted from Claude result events and displayed in StickyRunBar
- Context window indicator: token usage (input+output) vs model context window shown as color-coded progress bar; uses **per-request** tokens from `message_start` stream events (not cumulative `modelUsage` which inflates across turns); `Math.max` for contextWindow to prevent sub-agent regression; primary-model filtering via `parent_tool_use_id === null`
- Model name display: extracted from SDK events (`system` init, `modelUsage` result keys); streamed via `modelName` field on `StreamDelta`/`TurnMetrics`; displayed in StickyRunBar with date-suffix stripping (`formatModelName`); no hard-coded model list
- Attention queue: AskUserQuestion/permission tool_use events detected in SDK message stream, persisted to `attention_required` table, broadcast to ALL WS clients (cross-thread), resolvable via REST or WS with first-caller-wins race guard; `sendMessage()` orphans pending attention items (user is moving on — old questions become stale); turn_end handler defensively sets status to "waiting" when pending attention exists
- ExitPlanMode user approval: SDK bug where `requiresUserInteraction()` causes a Zod validation error in headless mode. Fix: ExitPlanMode is denied in `canUseTool` with `interrupt: true` (same flow as AskUserQuestion) — the parser creates a "confirmation" attention event with "Approve plan" / "Reject plan" options directly from the tool_use event. On approval, `resolveAttention` calls `setPermissionMode("bypassPermissions")` to exit plan mode at the CLI level before messaging the agent to proceed. Stream-death-with-pending-attention case handled by checking DB for pending items before marking error.
- Session IDs persisted to `session_id` column on threads table (survives server restart)
- Tunnel integration: `--tunnel` flag spawns cloudflared, captures URL, forces auth
- Push notifications: VAPID keys auto-generated, Web Push dispatch on attention events; per-subscription `origin` column on `push_subscriptions` table enables per-sub `targetUrl` in push payloads for cross-origin notification deep-links
- Service worker (`sw.js`): handles push display + notification click; uses server-provided `targetUrl` (per-subscription origin) with cross-origin fallback via `clients.openWindow`
- Tailscale detection: `TailscaleDetector` checks CLI installation, `tailscale status --json` for IP/hostname, `tailscale serve status --json` for HTTPS config; cached with configurable TTL; results shown at startup and via `/api/tailscale/status` endpoint
- Remote access settings: `RemoteAccessSettings` component in Settings panel shows Tailscale state (not detected / detected / HTTPS ready) with guided `tailscale serve` setup; `remoteUrl` setting (HTTPS-only, display-only) stored in settings table
- Mobile UI: bottom tab navigation (Inbox/Sessions/New), attention inbox with interactive cards; `MobileThreadHeader` provides sticky thread title with back button and editable title on mobile
- AI thread titles: `generateTitle()` in `titles/generator.ts` uses `query()` from the Agent SDK (fire-and-forget) to produce 3-6 word summaries; race guard compares current title against original `prompt.slice(0, 80)` to avoid overwriting user edits; PATCH `/threads/:id` broadcasts via `notifyThread()` for cross-client sync
- Inline title editing: `EditableTitle` component renders click-to-edit title with Enter/Escape/blur handling; used in both `MobileThreadHeader` and `ChatView`; optimistic update + WS broadcast
- Input: Enter sends, Shift+Enter for newline (with IME composition guard for CJK input)
- AskUserQuestion rendered inline as interactive cards with answer buttons
- WebSocket heartbeat prevents idle disconnection
- Slash command autocompletion: scoped per project via `installed_plugins.json` + `settings.json` (global + project-level merge); `.agents/` internal skills excluded; cached per projectId
- Worktree isolation: detectWorktree returns name for port/data separation, expanded port hash range (9999 slots)
- Worktree agent isolation: three-layer defense — (1) nested instance guard (`ORCHESTRA_MANAGED=1` blocks agents from relaunching Orchestra, override with `--allow-nested`), (2) env scrubbing (deletes `ORCHESTRA_PORT/DATA_DIR/HOST/ALLOW_NESTED` from `process.env` after startup), (3) prompt preamble injection (worktree threads get isolation context — port, cwd, rules — prepended to first prompt only; cwd sanitized for prompt injection)
- Git spawn helpers: all git command execution centralized via `gitSpawn()`/`gitSpawnSync()` in `utils/git.ts` — automatically prepends `--no-optional-locks` to reduce index.lock contention with concurrent agent operations
- Worktree branching: `git worktree add` always branches from detected main/master, not HEAD — prevents inheriting polluted checkout state from non-isolated agents
- Cross-client thread sync: thread creation and archival broadcast `thread_updated` via WS to all clients; client deduplicates optimistic inserts
- Worktree cleanup on archive: DELETE /threads/:id?cleanup_worktree=true removes worktree+branch; failures return cleanupFailed flag
- Bulk cleanup pushed: POST /projects/:id/cleanup-pushed archives all non-active threads whose worktree branches are fully pushed to remote (no uncommitted changes, no unpushed commits); project hamburger menu in sidebar triggers it
- PR status indicators: threads with PRs show status-aware badges (draft/open/merged/closed) with Octicons-style SVG icons and status-specific colors; `pr_status`, `pr_number`, `pr_status_checked_at` columns on threads table; `fetchPrStatus()` in `worktrees/pr-status.ts` spawns `gh pr view` with 10s timeout + max-3 concurrency semaphore; status refreshed fire-and-forget on thread list load (open/draft only, 5-min stale guard via dedicated `pr_status_checked_at` column), on ContextPanel open, and via `POST /threads/:id/refresh-pr`; WS broadcast only when status actually changes; `PrBadge` shared component used in sidebar + mobile; sidebar badges are non-clickable (inside row button), ContextPanel has clickable URL + refresh button; null prStatus falls back to legacy green "PR" badge
- Session abort: persistent sessions use `Query.close()`; legacy sessions use AbortController. `aborted` flag distinguishes user-stop from SDK error
- Inactivity timeout (default 30 min, configurable via Settings) replaces PID-based health check for hung SDK iterators
- `pid` field in Thread type is always null (kept for API compat; SDK manages subprocess internally)
- Settings: key-value `settings` table in SQLite; GET/PATCH `/api/settings` with typed `Settings` interface; gear icon in sidebar footer + header; WorktreeManager updated live on save
- File attachments: paste/drag-drop/picker in InputBar → upload to DATA_DIR/uploads/ → file paths appended to Claude prompt so it can Read them → rendered inline in chat messages
- Inline image previews: when agent reads an image file (e.g., screenshot from browse tool), ReadRenderer detects image extension via `isImageFile()` and renders `<img>` pointing at `/api/files/serve?path=...` proxy endpoint; click opens `ImageLightbox` overlay; non-image binaries still show "Binary file" placeholder; SVG excluded from allowlist (XSS risk)
- File proxy endpoint: `GET /api/files/serve?path=<absolute-path-or-~/path>` serves local filesystem images plus safe inline documents (`.md/.markdown/.txt/.log/.json/.yaml/.yml/.csv/.pdf`) with extension allowlist, `~/` expansion, path traversal prevention (`..` blocked), and `nosniff`; text documents are forced to `text/plain`, PDFs keep `application/pdf`, auth middleware still applies for remote access, and cache remains `private, no-cache`
- Markdown local file links: `MarkdownContent` detects filesystem-style markdown hrefs (`/home/...`, `~/...`, `file://...`) and rewrites safe document/image links to `/api/files/serve?...`; unsupported localhost paths still open through `vscode://`, while remote sessions fall back to copy-path buttons
- Clickable file paths: `FilePathLink` component wraps file paths in renderer headers (Read, Search, Diff); on localhost renders `vscode://file/path:line` links; on remote renders copy-to-clipboard button (server paths don't exist on client device); `shortenPath()` extracted to shared `fileUtils.ts`
- Unread thread indicator: client-side `Set<string>` tracks threads with unseen `thread_updated` WS events; blue dot shown in ProjectSidebar and MobileSessions; cleared on thread selection; `activeThreadRef` handles WS race where event arrives before React state update
- **QA testing from worktrees**: You CANNOT test against the already-running main-branch instance. Each worktree gets its own port (via hash), so you must `cd` into the worktree, build the client (`cd client && bun run build`), and start a fresh server (`cd server && bun run src/index.ts`) there. Only then browse to the worktree's port for QA.
- Integrated terminal: xterm.js v6 (client) + Bun native PTY via `Bun.spawn({ terminal })` (server); TerminalManager uses event-emitter pattern (like SessionManager) with 50KB replay buffer for reconnect viewport restore, output batching at ~60fps, 15-min idle timeout, max 20 concurrent PTYs; toggle via `Ctrl+`` or header button; terminal panel sits below InputBar; PTY persists per-thread across switches (idempotent `terminal_create` returns existing); desktop only (hidden on mobile); server-side `closeForThread()` on thread archive prevents zombie PTYs

## Testing

```bash
bun test                        # Run all tests
```

Tests cover renderer parsing functions (including Bash preview truncation and exit-state parsing), server-side Claude SDK message parsing (including token usage extraction from modelUsage), SDK session lifecycle (abort, error, completion), filesystem route behavior, attention queue CRUD operations, slash command input logic, thread archive with worktree cleanup, settings CRUD (worktreeRoot validation, inactivityTimeoutMinutes bounds, remoteUrl HTTPS enforcement), and PR status utilities (URL number extraction, stale guard timing).
