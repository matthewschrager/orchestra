import { realpathSync } from "fs";
import { resolve, basename } from "path";

export function validateGitRepo(path: string): void {
  const check = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
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
    const result = Bun.spawnSync(["git", "branch", "--show-current"], {
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
    // git rev-parse --git-common-dir returns the shared .git of the main repo
    // git rev-parse --git-dir returns the worktree-specific .git path
    // If they differ, we're in a worktree.
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (commonDir.exitCode !== 0 || gitDir.exitCode !== 0) return null;

    const common = realpathSync(resolve(path, new TextDecoder().decode(commonDir.stdout).trim()));
    const git = realpathSync(resolve(path, new TextDecoder().decode(gitDir.stdout).trim()));

    if (common !== git) {
      // We're in a worktree — use the directory name as the worktree identifier
      const toplevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
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
