import { existsSync } from "fs";

// ── Constants ──────────────────────────────────────────
const MAX_PTYS = 20;
const IDLE_TIMEOUT_MS = 15 * 60_000; // 15 min
const REPLAY_BUFFER_SIZE = 50_000;   // characters
const MAX_INPUT_SIZE = 65_536;       // 64KB
const OUTPUT_BATCH_INTERVAL = 16;    // ms (~60fps)

// ── Types ──────────────────────────────────────────────

interface TerminalSession {
  proc: ReturnType<typeof Bun.spawn>;
  threadId: string;
  replayBuffer: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  outputBuffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  exitCode: number | null;
}

type Listener<T extends unknown[]> = (...args: T) => void;

// ── TerminalManager ────────────────────────────────────
// Event-emitter pattern (like SessionManager) — listeners survive WS reconnect.

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private dataListeners: Listener<[string, string]>[] = [];
  private exitListeners: Listener<[string, number]>[] = [];

  // Register listeners (WS handler calls these once at init)
  onData(fn: Listener<[string, string]>): void {
    this.dataListeners.push(fn);
  }
  onExit(fn: Listener<[string, number]>): void {
    this.exitListeners.push(fn);
  }

  /**
   * Create or reattach to a terminal for a thread.
   * Idempotent: if a PTY already exists, returns { created: false, reconnect: true }.
   */
  create(
    terminalId: string,
    cwd: string,
  ): { created: boolean; reconnect: boolean } {
    // Idempotent — return existing PTY
    if (this.sessions.has(terminalId)) {
      this.resetIdleTimer(terminalId);
      return { created: false, reconnect: true };
    }

    if (this.sessions.size >= MAX_PTYS) {
      throw new Error(`Max terminal limit (${MAX_PTYS}) reached`);
    }

    if (!existsSync(cwd)) {
      throw new Error(`Working directory not found: ${cwd}`);
    }

    const shell = process.env.SHELL || "/bin/bash";
    // Bun's PTY mode ignores the `cwd` option, and shell init files (e.g.
    // .zshrc) can override the working directory even with `cd + exec`.
    // Workaround: queue a `cd` into the PTY input buffer after spawn.
    // The terminal driver buffers it until the shell finishes initialization.
    // Leading space suppresses history (bash HISTCONTROL=ignorespace / zsh
    // HIST_IGNORE_SPACE). `clear` resets the screen for a clean start.
    const escapedCwd = cwd.replace(/'/g, "'\\''");

    const session: TerminalSession = {
      proc: null!,
      threadId: terminalId,
      replayBuffer: "",
      idleTimer: null,
      outputBuffer: "",
      flushTimer: null,
      exited: false,
      exitCode: null,
    };

    session.proc = Bun.spawn([shell], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal: unknown, data: string) => {
          // Ring buffer for reconnect replay
          session.replayBuffer += data;
          if (session.replayBuffer.length > REPLAY_BUFFER_SIZE) {
            session.replayBuffer = session.replayBuffer.slice(
              -REPLAY_BUFFER_SIZE,
            );
          }
          // Batch output at ~60fps
          session.outputBuffer += data;
          if (!session.flushTimer) {
            session.flushTimer = setTimeout(() => {
              const batch = session.outputBuffer;
              session.outputBuffer = "";
              session.flushTimer = null;
              for (const fn of this.dataListeners) fn(terminalId, batch);
            }, OUTPUT_BATCH_INTERVAL);
          }
        },
        exit: (_terminal: unknown, exitCode: number) => {
          session.exited = true;
          session.exitCode = exitCode;
          for (const fn of this.exitListeners) fn(terminalId, exitCode);
        },
      },
    });

    this.sessions.set(terminalId, session);
    this.resetIdleTimer(terminalId);

    // Queue cd into the PTY input buffer — runs after shell init completes.
    session.proc.terminal.write(` cd '${escapedCwd}' && clear\n`);

    return { created: true, reconnect: false };
  }

  /** Get replay buffer for reconnect viewport restoration. */
  getReplayBuffer(id: string): string | null {
    return this.sessions.get(id)?.replayBuffer ?? null;
  }

  /** Write input to PTY. Silently rejects oversized data. */
  write(id: string, data: string): void {
    if (data.length > MAX_INPUT_SIZE) return;
    const s = this.sessions.get(id);
    if (s && !s.exited) {
      s.proc.terminal.write(data);
      this.resetIdleTimer(id);
    }
  }

  /** Resize PTY. Clamps to sane values. */
  resize(id: string, cols: number, rows: number): void {
    cols = Math.max(1, Math.min(500, cols));
    rows = Math.max(1, Math.min(200, rows));
    const s = this.sessions.get(id);
    if (s && !s.exited) {
      s.proc.terminal.resize(cols, rows);
    }
  }

  /** Close a terminal and clean up resources. */
  close(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      if (s.flushTimer) clearTimeout(s.flushTimer);
      this.sessions.delete(id);
      try {
        s.proc.terminal.close();
      } catch {
        /* already closed */
      }
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      // Emit exit for idle-timeout and explicit close (PTY exit callback may not fire)
      if (!s.exited) {
        s.exited = true;
        s.exitCode = -1;
        for (const fn of this.exitListeners) fn(id, -1);
      }
    }
  }

  /** Server-side lifecycle: close terminal when thread is archived/deleted. */
  closeForThread(threadId: string): void {
    this.close(threadId);
  }

  /** Close all terminals (server shutdown). */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  isExited(id: string): boolean {
    return this.sessions.get(id)?.exited ?? false;
  }

  private resetIdleTimer(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this.close(id), IDLE_TIMEOUT_MS);
  }
}
