# Orchestra

I wanted an agent dashboard that combined five things I couldn't find together:

- **Project-organized agent sessions** — threads grouped by repo, not scattered across terminal tabs
- **Model agnostic** — bring your own CLI agent, not locked to one provider
- **Mobile access to local sessions** — monitor and steer agents from your phone while they run on your laptop
- **Seamless worktree isolation** — one click to isolate a thread into its own git worktree, with PR creation built in
- **Use your existing subscriptions** — runs local CLI agents so you can use flat-rate plans (like Claude Pro/Max) instead of paying per token via API

Existing tools were either tied to a single model (Claude/Codex apps), required per-token API billing (Cursor etc.), or lacked first-class mobile access. 

Orchestra fills that gap.

<p>
  <img src="docs/screenshots/desktop-thread.png" alt="Desktop — thread view with code diffs, bash output, and sidebar" width="800" />
</p>

<p>
  <img src="docs/screenshots/mobile-sessions.png" alt="Mobile — session list" width="300" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/mobile-chat.png" alt="Mobile — chat view" width="300" />
</p>

## Features

- **Thread-based UX** — Manage agent conversations as threads with streaming output, inline Bash previews, collapsible tool blocks, and rich diffs
- **Remote/mobile access** — Use from your phone while agents run on your laptop, with push notifications for attention events
- **Git worktree isolation** — One-click isolation of a thread into its own worktree
- **PR creation** — Create PRs directly from worktree threads via `gh`, with auto-refreshing status badges
- **Multi-agent** — Bring your own CLIs; Claude Code and Codex adapters included, easy to add more
- **Integrated terminal** — xterm.js terminal per thread, backed by a real PTY on the server
- **Token auth** — Secure remote access with bearer token auth
- **PWA** — Installable on mobile for a native-app feel

## Quick start

**Prerequisites:** [Bun](https://bun.sh/) and [Git](https://git-scm.com/), plus at least one agent CLI — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or [Codex](https://github.com/openai/codex) (`codex`).

```bash
git clone <repo-url> && cd orchestra
./start.sh
```

That's it — `start.sh` installs dependencies, builds the frontend, and starts the server. Open [http://localhost:3847](http://localhost:3847) and click **"Add a project"** to register a git repo.

**Options:**

```bash
./start.sh --port 4000        # Custom port
./start.sh --tunnel            # Enable Cloudflare Tunnel for remote/phone access
./start.sh --help              # All options
```

<details>
<summary>Optional tools</summary>

- [`gh`](https://cli.github.com/) — PR creation from worktree threads
- [`tailscale`](https://tailscale.com/) — zero-config remote access
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) — Cloudflare Tunnel access
</details>

## Remote access

By default, Orchestra binds to `127.0.0.1` (localhost only). For remote/mobile access:

```bash
# Easiest: Cloudflare Tunnel (public URL, works from anywhere)
./start.sh --tunnel

# Or: bind to all interfaces on your LAN
ORCHESTRA_HOST=0.0.0.0 ./start.sh
```

Both generate a bearer token stored in `~/.orchestra/auth-token` — use it to sign in from other devices.

**Other options:**
- **Tailscale** — zero-config VPN; Orchestra auto-detects Tailscale identity headers for browser sessions
- **SSH tunnel** — `ssh -L 3847:localhost:3847 <host>`

## Development

```bash
bun run dev   # Starts backend (hot reload) + frontend (HMR) concurrently
```

Or run them separately: `bun run dev:server` and `bun run dev:client` in two terminals. The Vite dev server proxies API and WebSocket requests to the backend.

## CLI

You can also manage Orchestra via the CLI:

```bash
bun run server/src/cli.ts add <path>         # Register a project (git repo)
bun run server/src/cli.ts auth show          # Show auth token
bun run server/src/cli.ts auth regenerate    # Generate new token
bun run server/src/cli.ts help               # Show all commands
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRA_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `ORCHESTRA_PORT` | `3847` | Server port |
| `ORCHESTRA_DATA_DIR` | `~/.orchestra` | Data directory (SQLite DB, auth token, uploads) |

## Architecture

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

| Layer | Choice |
|-------|--------|
| Runtime | Bun |
| Backend | Hono |
| Frontend | React + Vite + Tailwind CSS |
| Database | SQLite (via Bun) |

- **Server** (`server/`) — Hono API server with WebSocket support, SQLite persistence, agent process management, and worktree lifecycle
- **Client** (`client/`) — React SPA with streaming chat, thread sidebar, context panel, mobile-responsive layout
- **Shared** (`shared/`) — TypeScript types shared between server and client
- **Agent adapters** (`server/src/agents/`) — Thin wrappers that know how to spawn and parse output from each CLI agent

## License

MIT
