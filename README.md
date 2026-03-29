# Orchestra

I wanted an agent dashboard that combined a set of features I couldn't find together:

- **Project-organized agent sessions** — Threads grouped by repo, not scattered across terminal tabs
- **Mobile access to local sessions** — Monitor and steer agents from your phone while they run on your laptop
- **Model agnostic** — Bring your own agent, not locked to one provider
- **Parallel development** — One-click worktree isolation, convenience functions to manage many worktrees simultaneously
- **Use existing subscriptions** — Runs local agents to leverage flat-rate plans (like Claude Pro/Max) rather than paying per token via API
- **Cross-platform** - Accessible from Windows, Mac, Linux, etc.

Existing tools were either not agent first, tied to a single model provider (Claude/Codex apps), Mac-only (Conductor), required per-token API billing (Cursor etc.), or lacked first-class mobile access to local sessions (Cloud Agents etc.). Orchestra fills that gap. 

Have a feature idea while walking the dog? Spin up a new thread from your phone, it runs on your laptop using your existing subscriptions (no pay-by-the-token). It has access to your local environment (skills, plugins, dev environment, etc.) - no need for a cloud VM to rebuild your environment every time. Before long, you'll find yourself managing dozens of threads across multiple projects. And you can do it from anywhere.

<b>Manage your agents from any model provider, using your existing subscriptions, from wherever you are.</b>

#### Desktop

<p>
  <img src="docs/screenshots/desktop-thread.png" alt="Desktop — thread view with code diffs, bash output, and sidebar" width="800" />
</p>

#### Mobile access to local sessions
<p>
  <img src="docs/screenshots/mobile-sessions.png" alt="Mobile — session list" width="300" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/mobile-chat.png" alt="Mobile — chat view" width="300" />
</p>

## Features

- **Thread-based UX** — Manage agent conversations as threads with streaming output, inline previews, collapsible tool blocks, and rich diffs
- **Remote/mobile access** — Use from your phone while agents run on your laptop, with push notifications for attention events
- **Worktree isolation** — One-click per-thread worktree isolation, with convenience functions for managing many worktrees simultaneously
- **Parallel Dev Made Easy** — Isolated worktrees by default, one-click to merge all outstanding PRs, one-click to delete all threads with merged PRs, etc. 
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

| Method | Setup | Auth | Best for |
|--------|-------|------|----------|
| **Tailscale Serve** | One command | Automatic (identity headers) | Daily use from phone/tablet |
| **Cloudflare Tunnel** | `./start.sh --tunnel` | QR code (scan to auth) | Quick setup, no VPN needed |
| **LAN** | `ORCHESTRA_HOST=0.0.0.0` | Bearer token | Same network only |
| **SSH tunnel** | `ssh -L 3847:localhost:3847 host` | None (local) | Quick one-off access |

All remote methods (except SSH tunnel) generate a bearer token stored in `~/.orchestra/auth-token`.

### Tailscale (recommended)

[Tailscale](https://tailscale.com/) gives you a private HTTPS URL (e.g. `https://mybox.tail1234.ts.net`) accessible from any device on your tailnet — no port forwarding, no public exposure. Orchestra has first-class Tailscale integration with automatic browser sign-in.

**Setup:**

1. [Install Tailscale](https://tailscale.com/download) on both your server machine and your phone/tablet
2. Start Orchestra: `./start.sh`
3. Enable HTTPS serving (proxies Tailscale HTTPS → Orchestra HTTP):
   ```bash
   tailscale serve --bg 3847
   ```
4. Open `https://<your-hostname>.ts.net` on your phone

That's it. Browser sessions sign in automatically — no token needed.

**Guided setup in the UI:** You can also set this up from **Settings → Remote Access**, which detects your Tailscale status and shows the exact commands to run. It will flag misconfigurations (wrong port, HTTPS mismatch) and tell you how to fix them.

**Tagged devices:** [Tagged nodes](https://tailscale.com/kb/1068/tags) can't sign in automatically — use the bearer token from `~/.orchestra/auth-token` instead.

**Troubleshooting:**
```bash
tailscale serve status --json      # Check current serve config
tailscale serve reset              # Clear config and start fresh
tailscale serve --bg 3847          # Re-enable
```

### Cloudflare Tunnel

```bash
./start.sh --tunnel
```

Prints a QR code to your terminal — scan it from your phone to open Orchestra and auto-authenticate. The token is embedded in the URL, so there's nothing to copy-paste. The bearer token is also saved to `~/.orchestra/auth-token` if you need it.

### LAN / manual

```bash
ORCHESTRA_HOST=0.0.0.0 ./start.sh
```

Binds to all interfaces. Access via `http://<local-ip>:3847` and authenticate with the bearer token.

### SSH tunnel

```bash
ssh -L 3847:localhost:3847 <host>
```

Forwards the port locally — no auth needed since traffic stays on `localhost`.

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
