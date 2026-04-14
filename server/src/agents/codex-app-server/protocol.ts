import { toCodexPermissionConfig, type PermissionMode } from "shared";

export interface CodexThreadConfig {
  cwd: string;
  effortLevel?: string;
  model?: string;
  permissionMode?: string;
}

export interface CodexStartSessionOptions extends CodexThreadConfig {
  prompt: string;
  resumeSessionId?: string;
}

export interface CodexNormalizedTodoItem {
  text: string;
  completed: boolean;
  status?: "pending" | "in_progress" | "completed";
}

export type CodexNormalizedItem =
  | { id: string; type: "agent_message"; text: string }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output?: string;
      exit_code?: number | null;
    }
  | {
      id: string;
      type: "file_change";
      changes: Array<{ path?: string; kind?: string; diff?: string }>;
      status?: string;
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server?: string;
      tool: string;
      status?: string;
      arguments: unknown;
      result?: { content?: unknown; structured_content?: unknown } | null;
      error?: { message?: string } | null;
      duration_ms?: number | null;
    }
  | { id: string; type: "web_search"; query: string; action?: string | null }
  | { id: string; type: "reasoning"; summary?: string[]; content?: string[] }
  | { id: string; type: "todo_list"; items: CodexNormalizedTodoItem[] };

export type CodexNormalizedEvent =
  | { type: "thread.started"; thread_id: string; model_name?: string }
  | { type: "turn.started"; turn_id: string }
  | {
      type: "turn.completed";
      turn_id: string;
      status?: "completed" | "interrupted";
    }
  | { type: "turn.failed"; turn_id: string; error: { message?: string } }
  | {
      type: "thread.token_usage.updated";
      usage: {
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
        reasoning_output_tokens: number;
      };
      context_window?: number;
      model_name?: string;
    }
  | { type: "metrics.model"; model_name: string }
  | {
      type: "attention.request";
      attention: {
        kind: "ask_user" | "permission" | "confirmation";
        prompt: string;
        options?: string[];
        metadata: Record<string, unknown>;
      };
    }
  | { type: "item.started"; item: CodexNormalizedItem }
  | { type: "item.updated"; item: CodexNormalizedItem }
  | { type: "item.completed"; item: CodexNormalizedItem }
  | { type: "error"; message: string };

export interface CodexTransportPermissionConfig {
  approvalPolicy: "never" | "on-failure" | "on-request";
  sandboxMode: "danger-full-access" | "workspace-write";
}

export interface CodexTurnOverrides {
  cwd: string;
  approvalPolicy: "never" | "on-failure" | "on-request";
  sandboxPolicy:
    | { type: "dangerFullAccess" }
    | {
        type: "workspaceWrite";
        writableRoots: string[];
        readOnlyAccess: { type: "fullAccess" };
        networkAccess: boolean;
        excludeTmpdirEnvVar: boolean;
        excludeSlashTmp: boolean;
      };
  model?: string;
  effort?: "low" | "medium" | "high";
}

interface CodexNormalizerState {
  agentTextByItemId: Map<string, string>;
}

export function createCodexNormalizerState(): CodexNormalizerState {
  return {
    agentTextByItemId: new Map(),
  };
}

export function resetCodexNormalizerTurnState(state: CodexNormalizerState): void {
  state.agentTextByItemId.clear();
}

export function toCodexTransportConfig(mode?: PermissionMode | string | null): CodexTransportPermissionConfig {
  const config = toCodexPermissionConfig(mode);
  return {
    approvalPolicy: config.approvalPolicy === "unless-allow-listed"
      ? "on-request"
      : config.approvalPolicy,
    sandboxMode: config.sandboxMode === "container-only"
      ? "workspace-write"
      : "danger-full-access",
  };
}

export function buildThreadStartParams(config: CodexThreadConfig): Record<string, unknown> {
  const transport = toCodexTransportConfig(config.permissionMode as PermissionMode | undefined);
  return {
    model: config.model ?? null,
    cwd: config.cwd,
    approvalPolicy: transport.approvalPolicy,
    sandbox: transport.sandboxMode,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  };
}

export function buildTurnStartParams(
  threadId: string,
  prompt: string,
  config: CodexThreadConfig,
): Record<string, unknown> {
  const transport = toCodexTransportConfig(config.permissionMode as PermissionMode | undefined);
  const params: Record<string, unknown> = {
    threadId,
    input: [makeTextInput(prompt)],
    cwd: config.cwd,
    approvalPolicy: transport.approvalPolicy,
    sandboxPolicy: buildSandboxPolicy(config.cwd, transport.sandboxMode),
  };

  if (config.model) {
    params.model = config.model;
  }

  const effort = toCodexReasoningEffort(config.effortLevel);
  if (effort) {
    params.effort = effort;
  }

  return params;
}

export function normalizeCodexClientBootstrap(
  threadId: string,
  modelName?: string | null,
): CodexNormalizedEvent[] {
  const events: CodexNormalizedEvent[] = [{ type: "thread.started", thread_id: threadId }];
  if (modelName) {
    events[0].model_name = modelName;
  }
  return events;
}

export function normalizeCodexServerMessage(
  message: Record<string, unknown>,
  state: CodexNormalizerState,
): CodexNormalizedEvent[] {
  const method = typeof message.method === "string" ? message.method : null;
  const params = isObject(message.params) ? message.params : {};

  switch (method) {
    case "thread/tokenUsage/updated":
      return [normalizeTokenUsage(params)];

    case "turn/completed":
      return [normalizeTurnCompleted(params)];

    case "item/started": {
      const item = normalizeThreadItem(params.item);
      return item ? [{ type: "item.started", item }] : [];
    }

    case "item/completed": {
      const item = normalizeThreadItem(params.item);
      if (!item) return [];
      if (item.type === "agent_message") {
        state.agentTextByItemId.delete(item.id);
      }
      return [{ type: "item.completed", item }];
    }

    case "item/agentMessage/delta": {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!itemId || !delta) return [];
      const nextText = (state.agentTextByItemId.get(itemId) ?? "") + delta;
      state.agentTextByItemId.set(itemId, nextText);
      return [{
        type: "item.updated",
        item: { id: itemId, type: "agent_message", text: nextText },
      }];
    }

    case "turn/plan/updated":
      return [normalizePlanUpdate(params)];

    case "model/rerouted": {
      const modelName = typeof params.toModel === "string" ? params.toModel : "";
      return modelName ? [{ type: "metrics.model", model_name: modelName }] : [];
    }

    case "error": {
      const error = isObject(params.error) ? params.error : {};
      const messageText = typeof error.message === "string" && error.message
        ? error.message
        : "Codex app-server error";
      return [{ type: "error", message: messageText }];
    }

    default:
      return [];
  }
}

export function normalizeCodexServerRequest(message: Record<string, unknown>): CodexNormalizedEvent | null {
  const requestId = typeof message.id === "number" || typeof message.id === "string"
    ? message.id
    : null;
  const method = typeof message.method === "string" ? message.method : "";
  const params = isObject(message.params) ? message.params : {};
  if (requestId === null || !method) return null;

  const baseMetadata: Record<string, unknown> = {
    source: "codex_app_server_request",
    codexRequestId: requestId,
    codexRequestMethod: method,
    codexRequestParams: params,
  };

  switch (method) {
    case "execCommandApproval":
      return {
        type: "attention.request",
        attention: {
          kind: "permission",
          prompt: formatExecCommandPrompt(params),
          metadata: baseMetadata,
        },
      };

    case "applyPatchApproval":
      return {
        type: "attention.request",
        attention: {
          kind: "permission",
          prompt: formatApplyPatchPrompt(params),
          metadata: baseMetadata,
        },
      };

    case "item/commandExecution/requestApproval":
      return {
        type: "attention.request",
        attention: {
          kind: "permission",
          prompt: formatCommandExecutionPrompt(params),
          metadata: baseMetadata,
        },
      };

    case "item/fileChange/requestApproval":
      return {
        type: "attention.request",
        attention: {
          kind: "permission",
          prompt: formatFileChangePrompt(params),
          metadata: baseMetadata,
        },
      };

    case "item/permissions/requestApproval":
      return {
        type: "attention.request",
        attention: {
          kind: "permission",
          prompt: formatPermissionsPrompt(params),
          metadata: baseMetadata,
        },
      };

    case "item/tool/requestUserInput":
      return {
        type: "attention.request",
        attention: {
          kind: "ask_user",
          prompt: formatToolRequestPrompt(params),
          options: extractSingleQuestionOptions(params),
          metadata: baseMetadata,
        },
      };

    case "mcpServer/elicitation/request":
      return {
        type: "attention.request",
        attention: {
          kind: "ask_user",
          prompt: formatMcpElicitationPrompt(params),
          metadata: baseMetadata,
        },
      };

    default:
      return {
        type: "attention.request",
        attention: {
          kind: "confirmation",
          prompt: `Codex requested input via ${method}. Review this request in the thread and respond there.`,
          metadata: baseMetadata,
        },
      };
  }
}

function normalizeTokenUsage(params: Record<string, unknown>): CodexNormalizedEvent {
  const tokenUsage = isObject(params.tokenUsage) ? params.tokenUsage : {};
  const last = isObject(tokenUsage.last) ? tokenUsage.last : {};
  return {
    type: "thread.token_usage.updated",
    usage: {
      input_tokens: numberOrZero(last.inputTokens),
      cached_input_tokens: numberOrZero(last.cachedInputTokens),
      output_tokens: numberOrZero(last.outputTokens),
      reasoning_output_tokens: numberOrZero(last.reasoningOutputTokens),
    },
    context_window: typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : undefined,
  };
}

function normalizeTurnCompleted(params: Record<string, unknown>): CodexNormalizedEvent {
  const turn = isObject(params.turn) ? params.turn : {};
  const turnId = typeof turn.id === "string" ? turn.id : "";
  const status = typeof turn.status === "string" ? turn.status : "";
  if (status === "failed") {
    const error = isObject(turn.error) ? turn.error : {};
    return {
      type: "turn.failed",
      turn_id: turnId,
      error: {
        message: typeof error.message === "string" ? error.message : "Turn failed",
      },
    };
  }

  return {
    type: "turn.completed",
    turn_id: turnId,
    status: status === "interrupted" ? "interrupted" : "completed",
  };
}

function normalizePlanUpdate(params: Record<string, unknown>): CodexNormalizedEvent {
  const turnId = typeof params.turnId === "string" ? params.turnId : "plan";
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const items: CodexNormalizedTodoItem[] = plan.map((step) => {
    const record = isObject(step) ? step : {};
    const status = normalizePlanStatus(record.status);
    return {
      text: typeof record.step === "string" ? record.step : "",
      completed: status === "completed",
      status,
    };
  }).filter((item) => item.text);

  return {
    type: "item.updated",
    item: {
      id: `turn-plan:${turnId}`,
      type: "todo_list",
      items,
    },
  };
}

function normalizeThreadItem(raw: unknown): CodexNormalizedItem | null {
  const item = isObject(raw) ? raw : null;
  if (!item) return null;

  const itemId = typeof item.id === "string" ? item.id : "";
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!itemId || !itemType) return null;

  switch (itemType) {
    case "agentMessage":
      return { id: itemId, type: "agent_message", text: stringOrEmpty(item.text) };

    case "commandExecution":
      return {
        id: itemId,
        type: "command_execution",
        command: stringOrEmpty(item.command),
        aggregated_output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
        exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
      };

    case "fileChange":
      return {
        id: itemId,
        type: "file_change",
        changes: Array.isArray(item.changes)
          ? item.changes.map((change) => {
              const record = isObject(change) ? change : {};
              return {
                path: typeof record.path === "string" ? record.path : undefined,
                kind: typeof record.kind === "string" ? record.kind : undefined,
                diff: typeof record.diff === "string" ? record.diff : undefined,
              };
            })
          : [],
        status: typeof item.status === "string" ? item.status : undefined,
      };

    case "mcpToolCall":
      return {
        id: itemId,
        type: "mcp_tool_call",
        server: typeof item.server === "string" ? item.server : undefined,
        tool: stringOrEmpty(item.tool),
        status: typeof item.status === "string" ? item.status : undefined,
        arguments: item.arguments ?? {},
        result: isObject(item.result)
          ? {
              content: item.result.content,
              structured_content: item.result.structuredContent,
            }
          : null,
        error: isObject(item.error)
          ? { message: typeof item.error.message === "string" ? item.error.message : undefined }
          : null,
        duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
      };

    case "webSearch":
      return {
        id: itemId,
        type: "web_search",
        query: stringOrEmpty(item.query),
        action: typeof item.action === "string" ? item.action : null,
      };

    case "reasoning":
      return {
        id: itemId,
        type: "reasoning",
        summary: Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === "string") : [],
        content: Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === "string") : [],
      };

    default:
      return null;
  }
}

function buildSandboxPolicy(
  cwd: string,
  sandboxMode: CodexTransportPermissionConfig["sandboxMode"],
): CodexTurnOverrides["sandboxPolicy"] {
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function makeTextInput(text: string): Record<string, unknown> {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function toCodexReasoningEffort(effort?: string): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort;
    default:
      return undefined;
  }
}

function normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
  switch (value) {
    case "completed":
      return "completed";
    case "inProgress":
      return "in_progress";
    default:
      return "pending";
  }
}

function formatExecCommandPrompt(params: Record<string, unknown>): string {
  const command = Array.isArray(params.command)
    ? params.command.filter((part): part is string => typeof part === "string").join(" ")
    : "";
  const cwd = typeof params.cwd === "string" ? params.cwd : "";
  const reason = typeof params.reason === "string" && params.reason ? `\nReason: ${params.reason}` : "";
  return `Codex wants to run:\n${command || "(unknown command)"}${cwd ? `\nCWD: ${cwd}` : ""}${reason}`;
}

function formatApplyPatchPrompt(params: Record<string, unknown>): string {
  const fileChanges = isObject(params.fileChanges) ? Object.keys(params.fileChanges) : [];
  const reason = typeof params.reason === "string" && params.reason ? `\nReason: ${params.reason}` : "";
  const grantRoot = typeof params.grantRoot === "string" && params.grantRoot ? `\nGrant root: ${params.grantRoot}` : "";
  return `Codex wants to apply file changes to:\n${fileChanges.length > 0 ? fileChanges.join("\n") : "(unknown files)"}${reason}${grantRoot}`;
}

function formatCommandExecutionPrompt(params: Record<string, unknown>): string {
  const command = typeof params.command === "string" ? params.command : "";
  const cwd = typeof params.cwd === "string" ? params.cwd : "";
  const reason = typeof params.reason === "string" && params.reason ? `\nReason: ${params.reason}` : "";
  return `Codex wants to run:\n${command || "(unknown command)"}${cwd ? `\nCWD: ${cwd}` : ""}${reason}`;
}

function formatFileChangePrompt(params: Record<string, unknown>): string {
  const fileChanges = Array.isArray(params.changes)
    ? params.changes.map((change) => {
        const record = isObject(change) ? change : {};
        const path = typeof record.path === "string" ? record.path : "(unknown)";
        const kind = typeof record.kind === "string" ? record.kind : "change";
        return `${kind}: ${path}`;
      })
    : [];
  const reason = typeof params.reason === "string" && params.reason ? `\nReason: ${params.reason}` : "";
  return `Codex wants to apply:\n${fileChanges.length > 0 ? fileChanges.join("\n") : "(unknown file changes)"}${reason}`;
}

function formatPermissionsPrompt(params: Record<string, unknown>): string {
  const reason = typeof params.reason === "string" && params.reason ? `Reason: ${params.reason}\n` : "";
  const profile = isObject(params.permissions) ? params.permissions : {};
  const details: string[] = [];

  const network = isObject(profile.network) ? profile.network : {};
  if (network.enabled === true) {
    details.push("Network: enabled");
  }

  const fs = isObject(profile.fileSystem) ? profile.fileSystem : {};
  if (Array.isArray(fs.read) && fs.read.length > 0) {
    details.push(`Read: ${fs.read.join(", ")}`);
  }
  if (Array.isArray(fs.write) && fs.write.length > 0) {
    details.push(`Write: ${fs.write.join(", ")}`);
  }

  return `Codex is requesting additional permissions.\n${reason}${details.join("\n") || "(no details provided)"}`.trim();
}

function formatToolRequestPrompt(params: Record<string, unknown>): string {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) {
    return "Codex is asking for additional input.";
  }

  return questions.map((question, index) => {
    const record = isObject(question) ? question : {};
    const header = typeof record.header === "string" && record.header ? `${record.header}: ` : `Q${index + 1}: `;
    const prompt = typeof record.question === "string" ? record.question : "Provide input";
    return `${header}${prompt}`;
  }).join("\n");
}

function extractSingleQuestionOptions(params: Record<string, unknown>): string[] | undefined {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length !== 1) return undefined;
  const first = isObject(questions[0]) ? questions[0] : {};
  const options = Array.isArray(first.options) ? first.options : [];
  const labels = options.map((option) => {
    const record = isObject(option) ? option : {};
    return typeof record.label === "string" ? record.label : "";
  }).filter(Boolean);
  return labels.length > 0 ? labels : undefined;
}

function formatMcpElicitationPrompt(params: Record<string, unknown>): string {
  const message = typeof params.message === "string" && params.message
    ? params.message
    : "Codex is requesting MCP input.";
  const serverName = typeof params.serverName === "string" ? `\nServer: ${params.serverName}` : "";
  if (params.mode === "url" && typeof params.url === "string") {
    return `${message}${serverName}\nURL: ${params.url}`;
  }
  return `${message}${serverName}`;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
