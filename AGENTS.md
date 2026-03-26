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
│       │   ├── Codex.ts   Codex adapter
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
│       │   └── agents.ts   Agent listing
│       └── ws/handler.ts   WebSocket handler
├── client/          Vite + React + Tailwind frontend
│   └── src/
│       ├── App.tsx         Root component with auth gate
│       ├── components/     UI components
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
- Codex uses `-p` one-shot mode with `--resume` for multi-turn (Bun's stdin pipe doesn't work with Codex's interactive mode)
- Codex flags: `--output-format stream-json --include-partial-messages --dangerously-skip-permissions --verbose`
- Multi-project: single server manages multiple registered git repos via `projects` table
- Per-project worktree mutex — one running thread per project's main worktree
- Real-time streaming via ephemeral WebSocket deltas (not persisted to DB)
- Complete messages persisted to SQLite with WAL mode, seq-based replay on reconnect
- Token auth only enforced for non-localhost requests
- **QA testing from worktrees**: You CANNOT test against the already-running main-branch instance. Each worktree gets its own port (via hash), so you must `cd` into the worktree, build the client (`cd client && bun run build`), and start a fresh server (`cd server && bun run src/index.ts`) there. Only then browse to the worktree's port for QA.
