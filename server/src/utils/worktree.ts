import { homedir } from "os";
import { join } from "path";

export const DEFAULT_ORCHESTRA_PORT = 3847;
export const MANAGED_WORKTREE_DATA_DIRNAME = ".orchestra-worktree";

export function getIsolatedWorktreePort(
  worktreeName: string,
  basePort = DEFAULT_ORCHESTRA_PORT,
): number {
  let hash = 0;
  for (const ch of worktreeName) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const offset = (Math.abs(hash) % 9999) + 1;
  return basePort + offset;
}

export function getDefaultWorktreeDataDir(
  worktreeName: string,
  cwd: string,
  opts?: { orchestraManaged?: boolean; homeDir?: string },
): string {
  if (opts?.orchestraManaged) {
    return join(cwd, MANAGED_WORKTREE_DATA_DIRNAME);
  }
  return join(opts?.homeDir ?? homedir(), ".orchestra", `worktree-${worktreeName}`);
}
