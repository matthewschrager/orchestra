import { join, basename } from "path";
import { existsSync, rmSync } from "fs";
import type { DB, ThreadRow } from "../db";
import { getThread, updateThread } from "../db";

const DEFAULT_WORKTREE_ROOT = join(
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

  async create(threadId: string, repoPath: string): Promise<WorktreeInfo> {
    const repoName = basename(repoPath);
    const branch = `orchestra/${threadId}`;
    const wtPath = join(this.worktreeRoot, `${repoName}-${threadId}`);

    // Create the worktree
    const proc = Bun.spawn(
      ["git", "worktree", "add", wtPath, "-b", branch],
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
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd: thread.worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    // Also include untracked files
    const statusProc = Bun.spawn(
      ["git", "ls-files", "--others", "--exclude-standard"],
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
      const abProc = Bun.spawn(
        ["git", "rev-list", "--left-right", "--count", `${mainBranch}...${thread.branch}`],
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
    const statusProc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: thread.worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const status = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    if (status.trim()) {
      const addProc = Bun.spawn(["git", "add", "-A"], {
        cwd: thread.worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      await addProc.exited;

      const commitMsg = opts.commitMessage || thread.title;
      const commitProc = Bun.spawn(["git", "commit", "-m", commitMsg], {
        cwd: thread.worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      await commitProc.exited;
    }

    // Push
    const pushProc = Bun.spawn(
      ["git", "push", "-u", "origin", thread.branch!],
      { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
    );
    await pushProc.exited;
    if (pushProc.exitCode !== 0) {
      const stderr = await new Response(pushProc.stderr).text();
      throw new Error(`Failed to push: ${stderr}`);
    }

    // Create PR
    const title = opts.title || thread.title;
    const body = opts.body || `Created by Orchestra thread ${threadId}`;
    const prProc = Bun.spawn(
      ["gh", "pr", "create", "--title", title, "--body", body],
      { cwd: thread.worktree, stdout: "pipe", stderr: "pipe" },
    );
    const prUrl = (await new Response(prProc.stdout).text()).trim();
    await prProc.exited;

    if (prProc.exitCode !== 0) {
      const stderr = await new Response(prProc.stderr).text();
      throw new Error(`Failed to create PR: ${stderr}`);
    }

    updateThread(this.db, threadId, { pr_url: prUrl });
    return prUrl;
  }

  async cleanup(threadId: string, repoPath: string): Promise<void> {
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread?.worktree) return;

    // Remove worktree
    const proc = Bun.spawn(["git", "worktree", "remove", thread.worktree, "--force"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Delete branch
    if (thread.branch) {
      const branchProc = Bun.spawn(["git", "branch", "-D", thread.branch], {
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

  private async detectMainBranch(cwd: string): Promise<string> {
    const proc = Bun.spawn(
      ["git", "rev-parse", "--verify", "main"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    return proc.exitCode === 0 ? "main" : "master";
  }
}
