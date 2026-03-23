# Changelog

## [0.1.0.0] - 2026-03-22

### Added

- **Thread-based agent management** — Start, stop, and manage CLI agent sessions as threads with streaming output
- **Claude Code adapter** — Spawn Claude Code with `--output-format stream-json`, parse streaming output, handle stdin/lifecycle
- **Session manager** — Process lifecycle management with WebSocket bridge, SQLite persistence, and main worktree mutex
- **Git worktree isolation** — One-click isolation of a thread into its own worktree with branch management
- **PR creation** — Create PRs directly from worktree threads via `gh` with commit, push, and PR in one flow
- **Web frontend** — React + Tailwind SPA with thread sidebar, streaming chat view, collapsible tool blocks, and context panel
- **Token auth** — Bearer token authentication for secure remote access, localhost bypass, auth gate UI
- **Mobile responsive** — Bottom sheet context panel, safe-area insets, touch-friendly targets, PWA manifest
- **CLI entry point** — `orchestra serve`, `orchestra auth show/regenerate`, `orchestra help`
- **SQLite persistence** — Threads, messages, and agent configs with WAL mode and atomic seq assignment

### Fixed

- Atomic message sequence numbering (race condition prevention)
- Constant-time token comparison (timing attack prevention)
- Auth fails closed on unknown IP (was fail-open)
- SPA fallback properly awaits file read
- Git command stderr collected concurrently (reliable error messages)
- Commit exit code checked in PR creation flow
- repoPath validated as git repository before use
