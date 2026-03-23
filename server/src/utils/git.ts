import { realpathSync } from "fs";
import { resolve } from "path";

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
