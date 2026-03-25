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
    request<{ prUrl: string }>(`/threads/${id}/pr`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),

  cleanupWorktree: (id: string) =>
    request<import("shared").Thread>(`/threads/${id}/cleanup`, { method: "POST" }),

  updateThread: (id: string, fields: { title?: string }) =>
    request<import("shared").Thread>(`/threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),

  archiveThread: (id: string) =>
    request<{ ok: boolean }>(`/threads/${id}`, { method: "DELETE" }),

  // Attention
  listAttention: (threadId?: string) =>
    request<import("shared").AttentionItem[]>(
      `/attention${threadId ? `?threadId=${threadId}` : ""}`,
    ),

  listAgents: () =>
    request<Array<{ name: string; detected: boolean; version: string | null }>>("/agents"),

  listCommands: () =>
    request<import("shared").SlashCommand[]>("/commands"),

  // Uploads
  uploadFile,

  // Filesystem
  browsePath: (path?: string) =>
    request<{
      current: string;
      parent: string | null;
      directories: Array<{ name: string; path: string; isGitRepo: boolean }>;
    }>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
};
