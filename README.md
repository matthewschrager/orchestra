# Orchestra

The missing conductor for your local agent CLIs. Orchestra gives your existing agents (Claude Code, Codex, etc.) a web/mobile interface with thread management, git worktree isolation, and one-click PR creation.

```
┌─────────────────────────────────────┐
│  Web / Mobile UI                    │
│  Thread sidebar ← Chat → Context   │
└──────────────┬──────────────────────┘
               │ WebSocket + REST
┌──────────────┴──────────────────────┐
│  Bun + Hono Server                  │
│  Sessions │ Worktrees │ Agents      │
└──────────────┬──────────────────────┘
               │ stdin/stdout
┌──────────────┴──────────────────────┐
│  claude  │  codex  │  (any CLI)     │
└─────────────────────────────────────┘
```

## Features

- **Thread-based UX** — Manage agent conversations as threads with streaming output and collapsible tool blocks
- **Remote/mobile access** — Use from your phone while agents run on your laptop
- **Git worktree isolation** — One-click isolation of a thread into its own worktree
- **PR creation** — Create PRs directly from worktree threads via `gh`
- **Multi-agent** — Bring your own CLIs; Claude Code adapter included, more coming
- **Token auth** — Secure remote access with bearer token auth
- **PWA** — Installable on mobile for a native-app feel

## Quick start

```bash
# Install dependencies
bun install

# Build the frontend
cd client && bun run build && cd ..

# Start the server
cd server && bun run src/index.ts
```

Open [http://localhost:3000](http://localhost:3000).

## Development

```bash
# Terminal 1: backend with hot reload
bun run dev:server

# Terminal 2: frontend with HMR
bun run dev:client
```

The Vite dev server proxies API and WebSocket requests to the backend.

## Remote access

By default, Orchestra binds to `127.0.0.1` (localhost only). To enable remote access:

```bash
ORCHESTRA_HOST=0.0.0.0 bun run server/src/index.ts
```

This generates a bearer token stored in `~/.orchestra/auth-token`. You'll need it to connect from other devices.

**Recommended setup:**
- **Tailscale** — zero-config VPN, works from anywhere
- **LAN** — accessible on local WiFi
- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:3000`
- **SSH tunnel** — `ssh -L 3000:localhost:3000 <host>`

## CLI

```bash
bun run server/src/cli.ts serve          # Start the server (default)
bun run server/src/cli.ts auth show      # Show auth token
bun run server/src/cli.ts auth regenerate  # Generate new token
bun run server/src/cli.ts help           # Show help
```

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Bun |
| Backend | Hono |
| Frontend | React + Vite + Tailwind CSS |
| Database | SQLite (via Bun) |
| Package manager | Bun |

## Architecture

- **Server** (`server/`) — Hono API server with WebSocket support, SQLite persistence, agent process management, and worktree lifecycle
- **Client** (`client/`) — React SPA with streaming chat, thread sidebar, context panel, mobile-responsive layout
- **Shared** (`shared/`) — TypeScript types shared between server and client
- **Agent adapters** (`server/src/agents/`) — Thin wrappers that know how to spawn and parse output from each CLI agent

## License

MIT
