const BASE = "/api";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = localStorage.getItem("orchestra_auth_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

async function uploadFile(file: File): Promise<import("shared").Attachment> {
  const token = localStorage.getItem("orchestra_auth_token");
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE}/uploads`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }

  return res.json();
}

export const api = {
  // Projects
  listProjects: () =>
    request<import("shared").ProjectWithStatus[]>("/projects"),

  addProject: (body: import("shared").CreateProjectRequest) =>
    request<import("shared").Project>("/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  renameProject: (id: string, name: string) =>
    request<import("shared").Project>(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  cleanupPushedThreads: (projectId: string, body?: { confirmedThreadIds?: string[] }) =>
    request<import("shared").CleanupPushedResponse>(`/projects/${projectId}/cleanup-pushed`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  mergeAllPrs: (projectId: string, agent: string) =>
    request<import("shared").Thread>(`/projects/${projectId}/merge-all-prs`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    }),

  // Threads
  listThreads: () => request<import("shared").Thread[]>("/threads"),

  getThread: (id: string) => request<import("shared").Thread>(`/threads/${id}`),

  getMessages: (id: string, afterSeq = 0) =>
    request<import("shared").Message[]>(`/threads/${id}/messages?after_seq=${afterSeq}`),

  createThread: (body: import("shared").CreateThreadRequest) =>
    request<import("shared").Thread>("/threads", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  stopThread: (id: string) =>
    request<import("shared").Thread>(`/threads/${id}/stop`, { method: "POST" }),

  sendMessage: (id: string, content: string) =>
    request<{ ok: boolean }>(`/threads/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  isolateThread: (id: string) =>
    request<import("shared").Thread>(`/threads/${id}/isolate`, { method: "POST" }),

  getWorktreeStatus: (id: string) =>
    request<import("shared").WorktreeInfo>(`/threads/${id}/worktree`),

  createPR: (id: string, opts?: { title?: string; body?: string; commitMessage?: string }) =>
    request<import("shared").Thread>(`/threads/${id}/pr`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),

  cleanupWorktree: (id: string) =>
    request<import("shared").Thread>(`/threads/${id}/cleanup`, { method: "POST" }),

  refreshPrStatus: (id: string) =>
    request<import("shared").Thread>(`/threads/${id}/refresh-pr`, { method: "POST" }),

  updateThread: (id: string, fields: { title?: string }) =>
    request<import("shared").Thread>(`/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),

  archiveThread: (id: string, opts?: { cleanupWorktree?: boolean }) =>
    request<{ ok: boolean; cleanupFailed?: boolean }>(
      `/threads/${id}${opts?.cleanupWorktree ? "?cleanup_worktree=true" : ""}`,
      { method: "DELETE" },
    ),

  // Attention
  listAttention: (threadId?: string) =>
    request<import("shared").AttentionItem[]>(
      `/attention${threadId ? `?threadId=${threadId}` : ""}`,
    ),

  listAgents: () =>
    request<Array<{ name: string; detected: boolean; version: string | null }>>("/agents"),

  listCommands: (projectId?: string) =>
    request<import("shared").SlashCommand[]>(
      `/commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),

  // Uploads
  uploadFile,

  // Filesystem
  browsePath: (path?: string) =>
    request<{
      current: string;
      parent: string | null;
      directories: Array<{ name: string; path: string; isGitRepo: boolean }>;
    }>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  getProjectFiles: (projectId: string) =>
    request<{ files: string[]; truncated: boolean }>(
      `/fs/files?projectId=${encodeURIComponent(projectId)}`,
    ),

  searchFiles: (projectId: string, query: string, limit = 20) =>
    request<{ files: string[]; truncated: false }>(
      `/fs/files?projectId=${encodeURIComponent(projectId)}&query=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  // Settings
  getSettings: () => request<import("shared").Settings>("/settings"),

  updateSettings: (settings: Partial<import("shared").Settings>) =>
    request<import("shared").Settings>("/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),

  // Tailscale
  getTailscaleStatus: (refresh = false) =>
    request<import("shared").TailscaleStatus>(`/tailscale/status${refresh ? "?refresh=1" : ""}`),
};
