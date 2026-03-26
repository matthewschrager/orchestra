import { join, basename } from "path";
import { existsSync } from "fs";
import type { DB, ThreadRow } from "../db";
import { getThread, updateThread } from "../db";
import { gitSpawn } from "../utils/git";

export const DEFAULT_WORKTREE_ROOT = join(
  process.env.HOME || "~",
  "projects",
  "worktrees",
);

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export class WorktreeManager {
  private worktreeRoot: string;

  constructor(
    private db: DB,
    worktreeRoot?: string,
  ) {
    this.worktreeRoot = worktreeRoot || DEFAULT_WORKTREE_ROOT;
  }

  /** Update the worktree root (e.g., when settings change) */
  setWorktreeRoot(root: string): void {
    this.worktreeRoot = root;
  }

  getWorktreeRoot(): string {
    return this.worktreeRoot;
  }

  async create(threadId: string, repoPath: string, name?: string): Promise<WorktreeInfo> {
    const repoName = basename(repoPath);
    const dirName = name || `${repoName}-${threadId}`;
    // Support absolute paths (from directory picker) or names relative to worktreeRoot
    const wtPath = dirName.startsWith("/") ? dirName : join(this.worktreeRoot, dirName);
    const branch = `orchestra/${basename(wtPath)}`;

    // Always branch from main/master, not HEAD — prevents inheriting a dirty
    // checkout state if an agent previously switched the main repo's branch.
    const mainBranch = await this.detectMainBranch(repoPath);

    // Create the worktree with explicit start-point
    const proc = gitSpawn(
      ["worktree", "add", wtPath, "-b", branch, mainBranch],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to create worktree: ${stderr}`);
    }

    return { path: wtPath, branch };
  }

  async getStatus(
    threadId: string,
  ): Promise<{ aheadBehind: { ahead: number; behind: number }; changedFiles: string[] } | null> {
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread?.worktree) return null;
    if (!existsSync(thread.worktree)) return null;

    // Changed files
    const diffProc = gitSpawn(["diff", "--name-only", "HEAD"], {
      cwd: thread.worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    // Also include untracked files
    const statusProc = gitSpawn(
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
    );
    const untrackedText = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    const changedFiles = [
      ...diffText.trim().split("\n").filter(Boolean),
      ...untrackedText.trim().split("\n").filter(Boolean),
    ];

    // Ahead/behind (relative to main/master)
    let ahead = 0;
    let behind = 0;
    if (thread.branch) {
      const mainBranch = await this.detectMainBranch(thread.worktree);
      const abProc = gitSpawn(
        ["rev-list", "--left-right", "--count", `${mainBranch}...${thread.branch}`],
        { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
      );
      const abText = await new Response(abProc.stdout).text();
      await abProc.exited;
      const [b, a] = abText.trim().split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }

    return { aheadBehind: { ahead, behind }, changedFiles };
  }

  async createPR(
    threadId: string,
    opts: { title?: string; body?: string; commitMessage?: string } = {},
  ): Promise<string> {
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread?.worktree) throw new Error("Thread is not isolated to a worktree");

    // Stage and commit any uncommitted changes
    const statusProc = gitSpawn(["status", "--porcelain"], {
      cwd: thread.worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const status = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    if (status.trim()) {
      const addProc = gitSpawn(["add", "-A"], {
        cwd: thread.worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      await addProc.exited;

      const commitMsg = (opts.commitMessage || thread.title || "Orchestra commit").trim();
      if (!commitMsg) throw new Error("Commit message cannot be empty");

      const commitProc = gitSpawn(["commit", "-m", commitMsg], {
        cwd: thread.worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, commitStderr] = await Promise.all([
        new Response(commitProc.stdout).text(),
        new Response(commitProc.stderr).text(),
        commitProc.exited,
      ]);
      if (commitProc.exitCode !== 0) {
        throw new Error(`Failed to commit: ${commitStderr}`);
      }
    }

    // Push
    const pushProc = gitSpawn(
      ["push", "-u", "origin", thread.branch!],
      { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
    );
    const [, pushStderr] = await Promise.all([
      new Response(pushProc.stdout).text(),
      new Response(pushProc.stderr).text(),
      pushProc.exited,
    ]);
    if (pushProc.exitCode !== 0) {
      throw new Error(`Failed to push: ${pushStderr}`);
    }

    // Create PR (gh is not git — keep as Bun.spawn)
    const title = opts.title || thread.title;
    const body = opts.body || `Created by Orchestra thread ${threadId}`;
    const prProc = Bun.spawn(
      ["gh", "pr", "create", "--title", title, "--body", body],
      { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
    );
    const [prStdout, prStderr] = await Promise.all([
      new Response(prProc.stdout).text(),
      new Response(prProc.stderr).text(),
      prProc.exited,
    ]);

    if (prProc.exitCode !== 0) {
      throw new Error(`Failed to create PR: ${prStderr}`);
    }

    const prUrl = prStdout.trim();

    updateThread(this.db, threadId, { pr_url: prUrl });
    return prUrl;
  }

  async cleanup(threadId: string, repoPath: string): Promise<void> {
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread?.worktree) return;

    // Remove worktree
    const proc = gitSpawn(["worktree", "remove", thread.worktree, "--force"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Delete branch
    if (thread.branch) {
      const branchProc = gitSpawn(["branch", "-D", thread.branch], {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      await branchProc.exited;
    }

    updateThread(this.db, threadId, {
      worktree: null,
      branch: null,
      archived_at: new Date().toISOString(),
    });
  }

  /** Check if a worktree thread's branch has been fully pushed to remote */
  async isPushedToRemote(threadId: string): Promise<{ pushed: boolean; reason?: string }> {
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread?.worktree || !thread.branch) {
      return { pushed: false, reason: "no_worktree" };
    }
    if (!existsSync(thread.worktree)) {
      return { pushed: false, reason: "worktree_missing" };
    }

    // Check for uncommitted changes (ignore untracked files — they're artifacts
    // like PLAN.md, temp files, or test files from other agents)
    const statusProc = gitSpawn(["status", "--porcelain", "-uno"], {
      cwd: thread.worktree, stdout: "pipe", stderr: "pipe",
    });
    const statusText = await new Response(statusProc.stdout).text();
    await statusProc.exited;
    if (statusProc.exitCode !== 0) {
      return { pushed: false, reason: "git_error" };
    }
    if (statusText.trim()) {
      return { pushed: false, reason: "uncommitted_changes" };
    }

    // Check if branch exists on remote
    const remoteRef = `origin/${thread.branch}`;
    const refProc = gitSpawn(["rev-parse", "--verify", remoteRef], {
      cwd: thread.worktree, stdout: "pipe", stderr: "pipe",
    });
    await refProc.exited;
    if (refProc.exitCode !== 0) {
      return { pushed: false, reason: "not_on_remote" };
    }

    // Check for unpushed commits
    const logProc = gitSpawn(
      ["rev-list", "--count", `${remoteRef}..HEAD`],
      { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
    );
    const countText = await new Response(logProc.stdout).text();
    await logProc.exited;
    if (logProc.exitCode !== 0) {
      return { pushed: false, reason: "git_error" };
    }
    const unpushed = parseInt(countText.trim(), 10);
    if (isNaN(unpushed) || unpushed > 0) {
      return { pushed: false, reason: unpushed > 0 ? "unpushed_commits" : "git_error" };
    }

    return { pushed: true };
  }

  private async detectMainBranch(cwd: string): Promise<string> {
    const proc = gitSpawn(
      ["rev-parse", "--verify", "main"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    return proc.exitCode === 0 ? "main" : "master";
  }
}
