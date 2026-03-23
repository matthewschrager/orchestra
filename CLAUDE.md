# Orchestra

Agent-first development interface — a local web/mobile UI that orchestrates CLI agent sessions.

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
│       │   └── manager.ts  Process spawn, stdin/stdout routing, persistence
│       ├── worktrees/      Git worktree management
│       │   └── manager.ts  Create, status, PR, cleanup
│       ├── utils/          Shared utilities
│       │   └── git.ts      Git validation + branch detection
│       ├── routes/         REST API routes
│       │   ├── projects.ts Project CRUD
│       │   ├── threads.ts  Thread CRUD + actions
│       │   ├── agents.ts   Agent listing
│       │   ├── commands.ts Slash command listing
│       │   └── filesystem.ts Directory browser API
│       └── ws/handler.ts   WebSocket handler
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
│       └── hooks/          useWebSocket, useApi
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

- Agents are spawned as CLI processes (not SDK calls) — Orchestra wraps locally installed CLIs
- Claude Code uses `-p` one-shot mode with `--resume` for multi-turn (Bun's stdin pipe doesn't work with Claude's interactive mode)
- Claude Code flags: `--output-format stream-json --include-partial-messages --dangerously-skip-permissions --verbose`
- Multi-project: single server manages multiple registered git repos via `projects` table
- Multiple threads can run concurrently on the same project's main worktree
- Real-time streaming via ephemeral WebSocket deltas (not persisted to DB)
- Complete messages persisted to SQLite with WAL mode, seq-based replay on reconnect
- Token auth only enforced for non-localhost requests
- Rich tool renderers parse stream-json tool data into visual components (diffs, terminal blocks, search results)
- Shiki syntax highlighting lazy-loaded via module-level singleton with DOMPurify sanitization
- Streaming state managed via useReducer with turnEnded flag to prevent phantom "Thinking..." indicators
- Cost/duration metrics extracted from Claude result events and displayed in StickyRunBar

## Testing

```bash
bun test                        # Run all tests (49 tests across 3 files)
```

Tests cover renderer parsing functions, server-side Claude adapter event handling, and filesystem route behavior.
