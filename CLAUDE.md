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
│       │   └── registry.ts Agent registry
│       ├── sessions/       Session lifecycle management
│       │   └── manager.ts  SDK session orchestration, stream consumption, persistence
│       ├── worktrees/      Git worktree management
│       │   └── manager.ts  Create, status, PR, cleanup
│       ├── utils/          Shared utilities
│       │   └── git.ts      Git validation + branch detection
│       ├── routes/         REST API routes
│       │   ├── projects.ts Project CRUD
│       │   ├── threads.ts  Thread CRUD + actions
│       │   ├── agents.ts   Agent listing
│       │   ├── commands.ts Slash command listing
│       │   ├── filesystem.ts Directory browser API
│       │   ├── attention.ts Attention queue API
│       │   ├── push.ts     Push subscription API
│       │   ├── uploads.ts  File upload + serve API
│       │   ├── settings.ts Settings CRUD API
│       │   └── tailscale.ts Tailscale status API
│       ├── push/           Web Push notification management
│       │   └── manager.ts  VAPID keys, subscriptions, dispatch
│       ├── tailscale/      Tailscale detection
│       │   └── detector.ts CLI detection, IP/hostname, serve config parsing
│       ├── tunnel/         Cloudflare Tunnel integration
│       │   └── manager.ts  Tunnel lifecycle, URL capture
│       └── ws/handler.ts   WebSocket handler + attention events
├── client/          Vite + React + Tailwind frontend
│   └── src/
│       ├── App.tsx         Root component with auth gate + streaming reducer
│       ├── components/     UI components
│       │   ├── ChatView.tsx      Chat messages + tool rendering
│       │   ├── StickyRunBar.tsx  Real-time status + metrics strip
│       │   ├── InputBar.tsx      Message input with slash commands
│       │   ├── ProjectSidebar.tsx Project/thread navigation
│       │   └── renderers/        Rich tool output renderers
│       │       ├── DiffRenderer.tsx    Edit → inline diff
│       │       ├── BashRenderer.tsx    Bash → terminal block
│       │       ├── ReadRenderer.tsx    Read → syntax-highlighted file
│       │       ├── SearchRenderer.tsx  Grep/Glob → match list
│       │       └── SubAgentCard.tsx    Agent → status card
│       │   ├── AttentionInbox.tsx  Attention queue inbox
│       │   ├── SettingsPanel.tsx   Settings modal dialog
│       │   ├── RemoteAccessSettings.tsx Remote Access section (Tailscale detection + guided setup)
│       │   ├── MobileNav.tsx      Bottom tab navigation
│       │   ├── MobileSessions.tsx Thread list for mobile
│       │   ├── MobileNewSession.tsx New session form for mobile
│       │   ├── SlashCommandInput.tsx Textarea with slash command autocomplete
│       │   └── AttachmentPreview.tsx Thumbnail previews for file attachments
│       ├── lib/             Shared utilities
│       │   └── askUser.ts   AskUserQuestion parsing + inline rendering helpers
│       └── hooks/          useWebSocket, useApi, useAttention, usePushNotifications
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
- Legacy sessions (non-persistent adapters): `query()` with `resume` per turn
- SDK options: `permissionMode: "bypassPermissions"`, `cwd` per-call for multi-project isolation
- Multi-project: single server manages multiple registered git repos via `projects` table
- Multiple threads can run concurrently on the same project's main worktree
- Real-time streaming via ephemeral WebSocket deltas (not persisted to DB)
- Complete messages persisted to SQLite with WAL mode, seq-based replay on reconnect
- Token auth enforced for non-localhost requests (and always when `--tunnel` is active)
- Rich tool renderers parse stream-json tool data into visual components (diffs, terminal blocks, search results)
- Shiki syntax highlighting lazy-loaded via module-level singleton with DOMPurify sanitization
- Streaming state managed via useReducer with turnEnded flag to prevent phantom "Thinking..." indicators
- Cost/duration/token metrics extracted from Claude result events and displayed in StickyRunBar
- Context window indicator: token usage (input+output) vs model context window shown as color-coded progress bar; uses replacement semantics (SDK reports cumulative totals); `Math.max` for contextWindow to prevent sub-agent regression
- Model name display: extracted from SDK events (`system` init, `message_start` stream, `modelUsage` result keys); streamed via `modelName` field on `StreamDelta`/`TurnMetrics`; displayed in StickyRunBar with date-suffix stripping (`formatModelName`); no hard-coded model list
- Attention queue: AskUserQuestion/permission tool_use events detected in SDK message stream, persisted to `attention_required` table, broadcast to ALL WS clients (cross-thread), resolvable via REST or WS with first-caller-wins race guard
- Session IDs persisted to `session_id` column on threads table (survives server restart)
- Tunnel integration: `--tunnel` flag spawns cloudflared, captures URL, forces auth
- Push notifications: VAPID keys auto-generated, Web Push dispatch on attention events; per-subscription `origin` column on `push_subscriptions` table enables per-sub `targetUrl` in push payloads for cross-origin notification deep-links
- Service worker (`sw.js`): handles push display + notification click; uses server-provided `targetUrl` (per-subscription origin) with cross-origin fallback via `clients.openWindow`
- Tailscale detection: `TailscaleDetector` checks CLI installation, `tailscale status --json` for IP/hostname, `tailscale serve status --json` for HTTPS config; cached with configurable TTL; results shown at startup and via `/api/tailscale/status` endpoint
- Remote access settings: `RemoteAccessSettings` component in Settings panel shows Tailscale state (not detected / detected / HTTPS ready) with guided `tailscale serve` setup; `remoteUrl` setting (HTTPS-only, display-only) stored in settings table
- Mobile UI: bottom tab navigation (Inbox/Sessions/New), attention inbox with interactive cards
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
- Session abort: persistent sessions use `Query.close()`; legacy sessions use AbortController. `aborted` flag distinguishes user-stop from SDK error
- Inactivity timeout (default 30 min, configurable via Settings) replaces PID-based health check for hung SDK iterators
- `pid` field in Thread type is always null (kept for API compat; SDK manages subprocess internally)
- Settings: key-value `settings` table in SQLite; GET/PATCH `/api/settings` with typed `Settings` interface; gear icon in sidebar footer + header; WorktreeManager updated live on save
- File attachments: paste/drag-drop/picker in InputBar → upload to DATA_DIR/uploads/ → file paths appended to Claude prompt so it can Read them → rendered inline in chat messages
- Unread thread indicator: client-side `Set<string>` tracks threads with unseen `thread_updated` WS events; blue dot shown in ProjectSidebar and MobileSessions; cleared on thread selection; `activeThreadRef` handles WS race where event arrives before React state update
- **QA testing from worktrees**: You CANNOT test against the already-running main-branch instance. Each worktree gets its own port (via hash), so you must `cd` into the worktree, build the client (`cd client && bun run build`), and start a fresh server (`cd server && bun run src/index.ts`) there. Only then browse to the worktree's port for QA.
- Integrated terminal: xterm.js v6 (client) + Bun native PTY via `Bun.spawn({ terminal })` (server); TerminalManager uses event-emitter pattern (like SessionManager) with 50KB replay buffer for reconnect viewport restore, output batching at ~60fps, 15-min idle timeout, max 20 concurrent PTYs; toggle via `Ctrl+`` or header button; terminal panel sits below InputBar; PTY persists per-thread across switches (idempotent `terminal_create` returns existing); desktop only (hidden on mobile); server-side `closeForThread()` on thread archive prevents zombie PTYs

## Testing

```bash
bun test                        # Run all tests
```

Tests cover renderer parsing functions, server-side Claude SDK message parsing (including token usage extraction from modelUsage), SDK session lifecycle (abort, error, completion), filesystem route behavior, attention queue CRUD operations, slash command input logic, thread archive with worktree cleanup, and settings CRUD (worktreeRoot validation, inactivityTimeoutMinutes bounds, remoteUrl HTTPS enforcement).
