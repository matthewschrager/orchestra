import { realpathSync } from "fs";
import { resolve, basename } from "path";

// ── Git spawn helpers ────────────────────────────────────
// Centralized git command execution with --no-optional-locks to avoid
// index.lock contention when agents are running concurrent git operations.
// Harmless on write commands (git ignores the flag for mandatory locks).

interface GitSpawnOpts {
  cwd: string;
  stdout: "pipe";
  stderr: "pipe";
}

/** Async git spawn with --no-optional-locks for read-side contention avoidance */
export function gitSpawn(args: string[], opts: GitSpawnOpts) {
  return Bun.spawn(["git", "--no-optional-locks", ...args], opts);
}

/** Sync git spawn with --no-optional-locks for read-side contention avoidance */
export function gitSpawnSync(args: string[], opts: GitSpawnOpts) {
  return Bun.spawnSync(["git", "--no-optional-locks", ...args], opts);
}

// ── Git utilities ────────────────────────────────────────

export function validateGitRepo(path: string): void {
  const check = gitSpawnSync(["rev-parse", "--git-dir"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    throw new Error("Not a git repository");
  }
}

export function resolveProjectPath(rawPath: string): string {
  const abs = resolve(rawPath);
  try {
    return realpathSync(abs);
  } catch {
    throw new Error("Path does not exist");
  }
}

export function getCurrentBranch(path: string): string {
  try {
    const result = gitSpawnSync(["branch", "--show-current"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    return new TextDecoder().decode(result.stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Detect if the given path is inside a git worktree (not the main repo).
 * Returns the worktree name (directory basename) if so, null otherwise.
 */
export function detectWorktree(path: string): string | null {
  try {
    const commonDir = gitSpawnSync(["rev-parse", "--git-common-dir"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const gitDir = gitSpawnSync(["rev-parse", "--git-dir"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (commonDir.exitCode !== 0 || gitDir.exitCode !== 0) return null;

    const common = realpathSync(resolve(path, new TextDecoder().decode(commonDir.stdout).trim()));
    const git = realpathSync(resolve(path, new TextDecoder().decode(gitDir.stdout).trim()));

    if (common !== git) {
      const toplevel = gitSpawnSync(["rev-parse", "--show-toplevel"], {
        cwd: path,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (toplevel.exitCode === 0) {
        return basename(new TextDecoder().decode(toplevel.stdout).trim());
      }
    }
    return null;
  } catch {
    return null;
  }
}
