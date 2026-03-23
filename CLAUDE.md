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
│       ├── routes/         REST API routes
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
- Claude Code uses `--output-format stream-json --dangerously-skip-permissions`
- Main worktree has a mutex — only one running thread at a time on main
- SQLite for persistence, WAL mode for concurrent reads
- WebSocket for real-time streaming, with seq-based replay on reconnect
- Token auth only enforced for non-localhost requests
