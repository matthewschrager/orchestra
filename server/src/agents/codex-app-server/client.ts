import {
  buildThreadStartParams,
  buildTurnStartParams,
  createCodexNormalizerState,
  normalizeCodexClientBootstrap,
  normalizeCodexServerRequest,
  normalizeCodexServerMessage,
  resetCodexNormalizerTurnState,
  type CodexNormalizedEvent,
  type CodexStartSessionOptions,
  type CodexThreadConfig,
} from "./protocol";
import type { AttentionResolution } from "shared";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

interface PendingServerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift() as T, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as T, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }
}

export class CodexAppServerClient {
  readonly events: AsyncIterable<CodexNormalizedEvent>;

  private readonly eventQueue = new AsyncQueue<CodexNormalizedEvent>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly normalizerState = createCodexNormalizerState();
  private readonly readyPromise: Promise<void>;
  private readonly stderrLines: string[] = [];
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();

  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextRequestId = 1;
  private closed = false;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private currentConfig: CodexThreadConfig;
  private pendingPriorityNowInput: string | null = null;
  /** Tracks an in-flight startTurn triggered by the interrupt→turn.completed flow.
   *  injectMessage awaits this to prevent concurrent turn/start requests. */
  private pendingTurnStartPromise: Promise<void> | null = null;

  constructor(private readonly opts: CodexStartSessionOptions) {
    this.events = this.eventQueue;
    this.currentConfig = {
      cwd: opts.cwd,
      effortLevel: opts.effortLevel,
      model: opts.model,
      permissionMode: opts.permissionMode,
    };
    this.readyPromise = this.bootstrap();
  }

  async injectMessage(text: string, priority: "now" | "next" = "next"): Promise<void> {
    await this.readyPromise;
    // Serialize behind any in-flight turn start from the interrupt→turn.completed flow.
    // Without this, a queue-drain injectMessage could race with the deferred startTurn.
    if (this.pendingTurnStartPromise) {
      await this.pendingTurnStartPromise;
    }
    if (!this.threadId) {
      throw new Error("Codex thread is not ready");
    }

    if (priority === "now" && this.activeTurnId) {
      this.pendingPriorityNowInput = text;
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
      return;
    }

    await this.startTurn(text);
  }

  async setModel(model: string): Promise<void> {
    this.currentConfig.model = model;
    await this.readyPromise;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.currentConfig.permissionMode = mode;
    await this.readyPromise;
  }

  async interruptActiveTurn(): Promise<void> {
    await this.readyPromise;
    if (!this.threadId || !this.activeTurnId) return;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
  }

  async resolveAttention(metadata: Record<string, unknown>, resolution: AttentionResolution): Promise<boolean> {
    await this.readyPromise;

    const requestId = metadata.codexRequestId;
    const requestKey = requestId === undefined || requestId === null ? "" : String(requestId);
    const pending = this.pendingServerRequests.get(requestKey);
    if (!pending) return false;

    const result = buildServerRequestResolution(pending, resolution);
    this.pendingServerRequests.delete(requestKey);

    const proc = this.proc;
    if (!proc || this.closed) {
      throw new Error("Codex app-server is not running");
    }
    proc.stdin.write(`${JSON.stringify({ id: pending.id, result })}\n`);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.eventQueue.close();

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("Codex app-server client closed"));
    }
    this.pendingRequests.clear();
    this.pendingServerRequests.clear();

    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  private async bootstrap(): Promise<void> {
    try {
      this.proc = Bun.spawn(["codex", "app-server"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      this.readLoop(this.proc.stdout, (line) => this.handleStdoutLine(line)).catch((err) => {
        this.handleFatal(err);
      });
      this.readLoop(this.proc.stderr, (line) => this.handleStderrLine(line)).catch(() => {});

      this.proc.exited.then((code) => {
        if (this.closed) return;
        this.handleUnexpectedExit(code);
      }).catch((err) => {
        if (this.closed) return;
        this.handleFatal(err);
      });

      await this.request("initialize", {
        clientInfo: {
          name: "orchestra",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["thread/started", "turn/started"],
        },
      });

      const response = this.opts.resumeSessionId
        ? await this.request("thread/resume", {
            threadId: this.opts.resumeSessionId,
            ...buildThreadStartParams(this.currentConfig),
          })
        : await this.request("thread/start", buildThreadStartParams(this.currentConfig));

      const threadId = getNestedString(response, "thread.id");
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id");
      }

      this.threadId = threadId;
      if (typeof response.model === "string" && response.model) {
        this.currentConfig.model = response.model;
      }
      for (const event of normalizeCodexClientBootstrap(threadId, typeof response.model === "string" ? response.model : null)) {
        this.eventQueue.push(event);
      }

      await this.startTurn(this.opts.prompt);
    } catch (err) {
      this.handleFatal(err);
      throw err;
    }
  }

  private async startTurn(prompt: string): Promise<void> {
    if (!this.threadId) {
      throw new Error("Cannot start turn before thread is ready");
    }

    resetCodexNormalizerTurnState(this.normalizerState);
    const response = await this.request("turn/start", buildTurnStartParams(this.threadId, prompt, this.currentConfig));
    const turnId = getNestedString(response, "turn.id");
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id");
    }

    this.activeTurnId = turnId;
    this.eventQueue.push({ type: "turn.started", turn_id: turnId });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const proc = this.proc;
    if (!proc || this.closed) {
      throw new Error("Codex app-server is not running");
    }

    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    proc.stdin.write(payload);

    return await new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  private async readLoop(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => Promise<void> | void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        await onLine(line);
      }
    }

    const tail = buffer.trim();
    if (tail) {
      await onLine(tail);
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;

    if ("id" in message && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && !("method" in message)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);

      if (message.error) {
        const error = isObject(message.error)
          ? new Error(typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error))
          : new Error(String(message.error));
        pending.reject(error);
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (!("method" in message)) return;

    if ("id" in message) {
      this.handleServerRequest(message);
      return;
    }

    const normalized = normalizeCodexServerMessage(message, this.normalizerState);
    for (const event of normalized) {
      if (event.type === "metrics.model" && event.model_name) {
        this.currentConfig.model = event.model_name;
      }
      this.eventQueue.push(event);

      if (event.type === "turn.completed" || event.type === "turn.failed") {
        this.activeTurnId = null;
        const nextInput = this.pendingPriorityNowInput;
        this.pendingPriorityNowInput = null;
        if (nextInput) {
          // CRITICAL: Do NOT await startTurn here — we are inside the readLoop's
          // onLine handler. startTurn sends turn/start to stdin and awaits the
          // response from stdout, but the readLoop can't read that response until
          // this handler returns. Awaiting here causes a permanent deadlock.
          // Fire-and-forget; injectMessage serializes behind pendingTurnStartPromise.
          this.pendingTurnStartPromise = this.startTurn(nextInput)
            .catch((err) => { if (!this.closed) this.handleFatal(err); })
            .finally(() => { this.pendingTurnStartPromise = null; });
        }
      }
    }
  }

  private handleServerRequest(message: Record<string, unknown>): void {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "server-request";
    if (id === undefined || id === null) return;

    const pending: PendingServerRequest = {
      id: id as string | number,
      method,
      params: isObject(message.params) ? message.params : {},
    };
    this.pendingServerRequests.set(String(id), pending);

    const normalized = normalizeCodexServerRequest(message);
    if (normalized) {
      this.eventQueue.push(normalized);
      return;
    }

    this.eventQueue.push({
      type: "error",
      message: `Codex app-server requested unsupported interaction via ${method}.`,
    });
  }

  private handleStderrLine(line: string): void {
    this.stderrLines.push(line);
    if (this.stderrLines.length > 20) {
      this.stderrLines.shift();
    }
  }

  private handleUnexpectedExit(code: number): void {
    const stderr = this.stderrLines.length > 0
      ? ` ${this.stderrLines.slice(-3).join(" | ")}`
      : "";
    this.handleFatal(new Error(`Codex app-server exited with code ${code}.${stderr}`));
  }

  private handleFatal(err: unknown): void {
    if (this.closed) return;
    const message = err instanceof Error ? err.message : String(err);
    this.eventQueue.push({ type: "error", message });
    this.eventQueue.close();
    this.closed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
    this.pendingServerRequests.clear();

    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }
}

function getNestedString(value: unknown, path: string): string | null {
  const keys = path.split(".");
  let current: unknown = value;
  for (const key of keys) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildServerRequestResolution(
  pending: PendingServerRequest,
  resolution: AttentionResolution,
): unknown {
  switch (pending.method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: resolution.type === "user" && resolution.action === "allow"
          ? "approved"
          : resolution.type === "orphaned" || resolution.type === "expired"
            ? "abort"
            : "denied",
      };

    case "item/commandExecution/requestApproval":
      return {
        decision: resolution.type === "user" && resolution.action === "allow"
          ? "accept"
          : resolution.type === "orphaned" || resolution.type === "expired"
            ? "cancel"
            : "decline",
      };

    case "item/fileChange/requestApproval":
      return {
        decision: resolution.type === "user" && resolution.action === "allow"
          ? "accept"
          : resolution.type === "orphaned" || resolution.type === "expired"
            ? "cancel"
            : "decline",
      };

    case "item/permissions/requestApproval": {
      const requested = isObject(pending.params.permissions) ? pending.params.permissions : {};
      return {
        permissions: resolution.type === "user" && resolution.action === "allow"
          ? requested
          : {},
        scope: "turn",
      };
    }

    case "item/tool/requestUserInput":
      return {
        answers: buildToolRequestAnswers(pending.params, resolution),
      };

    case "mcpServer/elicitation/request":
      return buildMcpElicitationResponse(pending.params, resolution);

    default:
      return {};
  }
}

function buildToolRequestAnswers(
  params: Record<string, unknown>,
  resolution: AttentionResolution,
): Record<string, { answers: string[] }> {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (resolution.type !== "user") {
    return {};
  }

  if (questions.length === 1) {
    const question = isObject(questions[0]) ? questions[0] : {};
    const questionId = typeof question.id === "string" ? question.id : "q1";
    const answer = extractSingleQuestionAnswer(question, resolution);
    return answer ? { [questionId]: { answers: [answer] } } : {};
  }

  if (!resolution.text?.trim()) {
    return {};
  }

  const parsedLines = new Map(
    resolution.text.split("\n").map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return ["", ""];
      return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
    }).filter(([key, value]) => key && value),
  );

  const answers: Record<string, { answers: string[] }> = {};
  questions.forEach((question, index) => {
    const record = isObject(question) ? question : {};
    const questionId = typeof record.id === "string" ? record.id : `q${index + 1}`;
    const header = typeof record.header === "string" && record.header ? record.header.toLowerCase() : `q${index + 1}`;
    const answer = parsedLines.get(header);
    if (answer) {
      answers[questionId] = { answers: [answer] };
    }
  });

  return answers;
}

function extractSingleQuestionAnswer(
  question: Record<string, unknown>,
  resolution: Extract<AttentionResolution, { type: "user" }>,
): string {
  if (resolution.action) {
    return resolution.action;
  }
  if (resolution.optionIndex !== undefined) {
    const options = Array.isArray(question.options) ? question.options : [];
    const option = options[resolution.optionIndex];
    if (isObject(option) && typeof option.label === "string") {
      return option.label;
    }
  }
  return resolution.text?.trim() ?? "";
}

function buildMcpElicitationResponse(
  params: Record<string, unknown>,
  resolution: AttentionResolution,
): unknown {
  if (resolution.type !== "user") {
    return { action: "cancel", content: null, _meta: null };
  }

  if (params.mode === "form") {
    if (!resolution.text?.trim()) {
      return { action: "decline", content: null, _meta: null };
    }

    const content: Record<string, string> = {};
    for (const line of resolution.text.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && value) {
        content[key] = value;
      }
    }

    return {
      action: Object.keys(content).length > 0 ? "accept" : "decline",
      content: Object.keys(content).length > 0 ? content : null,
      _meta: null,
    };
  }

  return {
    action: resolution.text?.trim() ? "accept" : "decline",
    content: resolution.text?.trim() ? { value: resolution.text.trim() } : null,
    _meta: null,
  };
}
