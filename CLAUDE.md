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
│       │   ├── codex.ts    Codex CLI adapter
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
│       │   └── settings.ts Settings CRUD API
│       ├── push/           Web Push notification management
│       │   └── manager.ts  VAPID keys, subscriptions, dispatch
│       ├── terminal/       Integrated terminal (PTY management)
│       │   └── manager.ts  PTY lifecycle, replay buffer, output batching
│       ├── tunnel/         Cloudflare Tunnel integration
│       │   └── manager.ts  Tunnel lifecycle, URL capture
│       └── ws/handler.ts   WebSocket handler + attention events + terminal routing
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
│       │   ├── MobileNav.tsx      Bottom tab navigation
│       │   ├── MobileSessions.tsx Thread list for mobile
│       │   ├── MobileNewSession.tsx New session form for mobile
│       │   ├── SlashCommandInput.tsx Textarea with slash command autocomplete
│       │   ├── AttachmentPreview.tsx Thumbnail previews for file attachments
│       │   └── TerminalPanel.tsx  Integrated xterm.js terminal
│       ├── lib/             Shared utilities
│       │   └── askUser.ts   AskUserQuestion parsing + inline rendering helpers
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
- Codex adapter uses `@openai/codex-sdk` (pinned v0.116.0) — ESM-only, loaded via `await import()` to avoid crash when not installed
- Codex sessions use `Thread.runStreamed()` with item-based events; text deltas computed by diffing `agent_message.text` updates
- Codex item types mapped to existing tool names: `command_execution` → Bash, `file_change` → Edit, `web_search` → WebSearch, `mcp_tool_call` → tool name, `todo_list` → TodoWrite
- Codex runs with `sandboxMode: "workspace-write"`, `approvalPolicy: "never"` — no interactive permission events
- Claude Code sessions use `query()` with `includePartialMessages: true` for streaming, `resume` for multi-turn
- SDK options: `permissionMode: "bypassPermissions"`, `cwd` per-call for multi-project isolation
- SessionManager is adapter-agnostic — uses `isAbortError()` helper instead of SDK-specific `AbortError` import
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
- Attention queue: AskUserQuestion/permission tool_use events detected in SDK message stream, persisted to `attention_required` table, broadcast to ALL WS clients (cross-thread), resolvable via REST or WS with first-caller-wins race guard
- Session IDs persisted to `session_id` column on threads table (survives server restart)
- Tunnel integration: `--tunnel` flag spawns cloudflared, captures URL, forces auth
- Push notifications: VAPID keys auto-generated, Web Push dispatch on attention events
- Mobile UI: bottom tab navigation (Inbox/Sessions/New), attention inbox with interactive cards
- Input: Enter sends, Shift+Enter for newline (with IME composition guard for CJK input)
- AskUserQuestion rendered inline as interactive cards with answer buttons
- WebSocket heartbeat prevents idle disconnection
- Slash command autocompletion: scoped per project via `installed_plugins.json` + `settings.json` (global + project-level merge); `.agents/` internal skills excluded; cached per projectId
- Worktree isolation: detectWorktree returns name for port/data separation, expanded port hash range (9999 slots)
- Worktree branching: `git worktree add` always branches from detected main/master, not HEAD — prevents inheriting polluted checkout state from non-isolated agents
- Cross-client thread sync: thread creation and archival broadcast `thread_updated` via WS to all clients; client deduplicates optimistic inserts
- Worktree cleanup on archive: DELETE /threads/:id?cleanup_worktree=true removes worktree+branch; failures return cleanupFailed flag
- Bulk cleanup pushed: POST /projects/:id/cleanup-pushed archives all non-active threads whose worktree branches are fully pushed to remote (no uncommitted changes, no unpushed commits); project hamburger menu in sidebar triggers it
- Session abort uses AbortController; `aborted` flag distinguishes user-stop from SDK error
- Inactivity timeout (default 30 min, configurable via Settings) replaces PID-based health check for hung SDK iterators
- `pid` field in Thread type is always null (kept for API compat; SDK manages subprocess internally)
- Settings: key-value `settings` table in SQLite; GET/PATCH `/api/settings` with typed `Settings` interface; gear icon in sidebar footer + header; WorktreeManager updated live on save
- File attachments: paste/drag-drop/picker in InputBar → upload to DATA_DIR/uploads/ → file paths appended to Claude prompt so it can Read them → rendered inline in chat messages
- Integrated terminal: xterm.js v6 (client) + Bun native PTY via `Bun.spawn({ terminal })` (server); TerminalManager uses event-emitter pattern (like SessionManager) with 50KB replay buffer for reconnect viewport restore, output batching at ~60fps, 15-min idle timeout, max 20 concurrent PTYs; toggle via `Ctrl+`` or header button; terminal panel sits below InputBar; PTY persists per-thread across switches (idempotent `terminal_create` returns existing); disabled when `--tunnel` is active (security); desktop only (hidden on mobile); server-side `closeForThread()` on thread archive prevents zombie PTYs

## Testing

```bash
bun test                        # Run all tests
```

Tests cover renderer parsing functions, server-side Claude SDK message parsing (including token usage extraction from modelUsage), Codex SDK event parsing (text diffing, tool mapping, backtrack guard), SDK session lifecycle (abort, error, completion), filesystem route behavior, attention queue CRUD operations, slash command input logic, thread archive with worktree cleanup, and terminal manager (PTY create/close/idempotent/limits/I/O/replay buffer).
