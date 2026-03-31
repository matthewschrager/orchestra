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
│       ├── auth.ts         Remote auth + Tailscale session bootstrap
│       ├── db/index.ts     SQLite schema + helpers
│       ├── agents/         Agent adapter interface + implementations
│       │   ├── types.ts    AgentAdapter interface
│       │   ├── claude.ts   Claude Code adapter
│       │   ├── codex.ts    Codex adapter
│       │   ├── registry.ts Agent registry
│       │   └── toolResultMedia.ts  Tool result media handling
│       ├── sessions/       Session lifecycle management
│       │   └── manager.ts  SDK session orchestration, stream consumption, persistence
│       ├── worktrees/      Git worktree management
│       │   ├── manager.ts  Create, status, PR, cleanup
│       │   ├── pr-status.ts PR status fetching via gh CLI
│       │   └── thread-pr-metadata.ts  Thread PR metadata
│       ├── projects/       Project-level operations
│       │   └── merge-all-prs.ts  Bulk PR merge
│       ├── terminal/       Integrated terminal
│       │   └── manager.ts  PTY lifecycle, replay buffer, idle timeout
│       ├── utils/          Shared utilities
│       │   ├── git.ts      Git validation + branch detection
│       │   ├── origins.ts  Shared allowed-origins helper (CORS/Origin/Host/WS)
│       │   └── worktree.ts Worktree detection helpers
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
│       │   ├── ChatView.tsx       Chat messages + tool rendering
│       │   ├── ContextPanel.tsx   Thread context/worktree panel
│       │   ├── StickyRunBar.tsx   Real-time status + metrics strip
│       │   ├── PinnedTodoPanel.tsx Pinned TODO list above input
│       │   ├── InputBar.tsx       Message input with slash commands
│       │   ├── MarkdownContent.tsx Markdown rendering with Shiki highlighting
│       │   ├── ProjectSidebar.tsx  Project/thread navigation
│       │   ├── TerminalPanel.tsx   xterm.js terminal panel
│       │   ├── WorktreePathInput.tsx Worktree root path selector
│       │   ├── OrchestraLogo.tsx   SVG logo component
│       │   ├── TodoItemList.tsx    Shared todo item list (card, inline, pinned)
│       │   ├── ArchiveConfirmationModal.tsx Archive thread confirmation dialog
│       │   ├── CleanupConfirmationModal.tsx Cleanup confirmation dialog
│       │   ├── MergeAllPrsButton.tsx Bulk PR merge trigger
│       │   ├── MergeAllPrsConfirmationModal.tsx Merge-all confirmation dialog
│       │   ├── renderers/         Rich tool output renderers
│       │   │   ├── DiffRenderer.tsx    Edit → inline diff
│       │   │   ├── BashRenderer.tsx    Bash → inline terminal preview
│       │   │   ├── ReadRenderer.tsx    Read → syntax-highlighted file
│       │   │   ├── SearchRenderer.tsx  Grep/Glob → match list
│       │   │   ├── SubAgentCard.tsx    Agent → status card
│       │   │   ├── TodoCard.tsx        TodoWrite → task checklist card
│       │   │   ├── TodoRenderer.tsx    TodoWrite inline renderer
│       │   │   └── ToolMediaRenderer.tsx Tool result media display
│       │   ├── AttentionInbox.tsx  Attention queue inbox
│       │   ├── SettingsPanel.tsx   Settings modal dialog
│       │   ├── RemoteAccessSettings.tsx Remote Access (Tailscale guided setup)
│       │   ├── MobileThreadHeader.tsx Mobile sticky header with editable title
│       │   ├── EditableTitle.tsx   Click-to-edit title (shared mobile/desktop)
│       │   ├── MobileNav.tsx       Bottom tab navigation
│       │   ├── MobileSessions.tsx  Thread list for mobile
│       │   ├── MobileNewSession.tsx New session form for mobile
│       │   ├── SlashCommandInput.tsx Textarea with slash command autocomplete
│       │   ├── AttachmentPreview.tsx Thumbnail previews for file attachments
│       │   ├── FilePathLink.tsx    Clickable file path (vscode:// local, copy remote)
│       │   ├── ImageLightbox.tsx   Full-screen image overlay
│       │   └── PrBadge.tsx         PR status badge (draft/open/merged/closed)
│       ├── lib/             Shared utilities
│       │   ├── askUser.ts   AskUserQuestion parsing + inline rendering helpers
│       │   ├── auth.ts      Auth token storage + validation
│       │   ├── asciiArt.ts  ASCII art logo for terminal display
│       │   ├── cleanup.ts   Worktree cleanup logic
│       │   ├── diffCompute.ts Myers LCS diff algorithm
│       │   ├── fileUtils.ts isImageFile, shortenPath, fileServeUrl utilities
│       │   ├── inputHistory.ts Per-thread input recall (ArrowUp/Down)
│       │   ├── prCounts.ts  PR counting utilities
│       │   └── shiki.ts     Shiki highlighter singleton + DOMPurify
│       └── hooks/           useWebSocket, useApi, useAttention, usePushNotifications, useTerminal
└── shared/          Shared TypeScript types
    └── effort.ts    Cost/effort calculation
```

## Commands

```bash
bun install                     # Install deps
bun run dev:server              # Dev server with watch
bun run dev:client              # Vite dev server with HMR
cd client && bun run build      # Build frontend to server/static/
cd server && bun run src/index.ts  # Production server
```

## Branching workflow

```
feature/foo ──PR──► staging ──PR──► main
feature/bar ──PR──┘              (batched when stable)
```

- **`main`** — stable, public-facing branch. What people clone. Only updated via PR from `staging`.
- **`staging`** — integration/dogfooding branch. All feature work merges here first.
- **Feature branches** — short-lived, PR into `staging` (never directly into `main`).
- When using `/ship` or creating PRs, **always target `staging`** as the base branch (e.g. `gh pr create --base staging`).
- Periodically, once changes on `staging` are dogfooded and stable, open a single PR from `staging → main`.
- External contributor PRs against `main` are fine — merge to `main`, then rebase `staging` on `main`.

## Key design decisions

- Agents use `@anthropic-ai/claude-agent-sdk` (pinned v0.2.81) — SDK manages subprocess lifecycle internally
- **Persistent sessions**: Claude Code sessions use a long-lived `Query` object per thread — subprocess stays alive between turns, follow-ups injected via `streamInput()`. State machine: `thinking → idle/waiting → thinking`. Falls back to legacy `resume` if subprocess crashes. Session IDs persisted to `session_id` column (survives restart). Abort: persistent uses `Query.close()`, legacy uses AbortController; `aborted` flag distinguishes user-stop from SDK error.
- **Message queuing**: Messages sent while agent is working are injected via `streamInput()` with `priority: 'next'`. Queue depth limit: 5 per turn. Non-persistent adapters (Codex) use blocking `query()` with `resume`.
- SDK options: `permissionMode` per-thread (default: `bypassPermissions` for worktree-isolated, `acceptEdits` for non-isolated), `cwd` per-call for multi-project isolation. Permission modes: `bypassPermissions`, `acceptEdits`, `default`, `plan`. Codex maps to `approvalPolicy` + `sandboxMode`.
- Multi-project: single server manages multiple registered git repos via `projects` table; multiple threads can run concurrently on the same project's worktree
- Real-time streaming via ephemeral WebSocket deltas (not persisted); complete messages persisted to SQLite with WAL mode, seq-based replay on reconnect; cross-client sync via `thread_updated` WS broadcasts
- Remote auth: localhost passwordless; LAN/Cloudflare Tunnel/SSH tunnel use bearer token; Tailscale Serve bootstraps signed `HttpOnly` cookie from identity headers
- Security: CORS/Origin/Host validation via shared `getAllowedOrigins()`; WebSocket Origin check on upgrade; CSP + X-Frame-Options + nosniff headers; filesystem browse restricted to `$HOME`; SQL column allowlists; per-client WS rate limiting (60/10s); DOMPurify on rendered HTML
- Attention queue: AskUserQuestion/permission events persisted to `attention_required` table, broadcast cross-thread to all WS clients, resolvable with first-caller-wins race guard; `sendMessage()` orphans pending items (user moved on)
- ExitPlanMode workaround: SDK `requiresUserInteraction()` causes Zod error in headless mode — denied in `canUseTool` with `interrupt: true`, creates confirmation attention event; on approval, `resolveAttention` calls `setPermissionMode()` to restore the thread's configured permission mode (or `bypassPermissions` if thread was in plan mode)
- Worktree isolation: three-layer defense — (1) nested instance guard (`ORCHESTRA_MANAGED=1`), (2) env scrubbing after startup, (3) prompt preamble injection with port/cwd/rules. Cleanup on archive via `?cleanup_worktree=true`; bulk cleanup via `POST /projects/:id/cleanup-pushed`
- Git: all commands via `gitSpawn()`/`gitSpawnSync()` with `--no-optional-locks`; `git worktree add` always branches from detected main/master, not HEAD
- **QA testing from worktrees**: Each worktree gets its own port (via hash). Build client (`bun run --filter client build`), start server with `ORCHESTRA_ALLOW_NESTED=1`, set `ORCHESTRA_DATA_DIR` to worktree-local path. Do not test against the main-branch instance.
- Inactivity timeout (default 30 min, configurable via Settings) replaces PID-based health check for hung SDK iterators
- Integrated terminal: xterm.js v6 (client) + Bun native PTY via `Bun.spawn({ terminal })` (server); PTY persists per-thread; desktop only
- Settings: key-value `settings` table in SQLite; GET/PATCH `/api/settings`; gear icon in sidebar; `autoScrollThreads` controls whether thread views follow new output by default; `defaultEffortLevel` pre-selects effort in new-thread forms (validated against agent support, falls back to agent default if unsupported); `defaultAgent` pre-selects agent in new-thread forms (validated against detected agents, hidden when only one agent available)

## Testing

```bash
bun test                        # Run all tests
```

Tests cover renderer parsing functions (including Todo payload variants, Bash preview truncation, diff precision on large files, and sticky run-bar token summaries), server-side Claude and Codex message parsing, Tailscale auth/origin hardening flows, filesystem route behavior, attention queue CRUD operations, slash command input logic, thread archive with worktree cleanup, settings CRUD (worktreeRoot validation, inactivityTimeoutMinutes bounds, autoScrollThreads validation, remoteUrl HTTPS enforcement, defaultEffortLevel validation, defaultAgent validation), PR status utilities (URL number extraction, stale guard timing), and worktree status (diff stats parsing, branch/no-branch scenarios).

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
