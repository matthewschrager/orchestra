import type { ServerWebSocket } from "bun";
import type { DB, MessageRow, ThreadRow } from "../db";
import { getMessages, getPendingAttention, getThread, attentionRowToApi, messageRowToApi, threadRowToApi } from "../db";
import type { SessionManager } from "../sessions/manager";
import type { TerminalManager } from "../terminal/manager";
import type { AttentionItem, StreamDelta, WSClientMessage, WSServerMessage } from "shared";

interface WSData {
  subscriptions: Set<string>;
}

export function createWSHandler(
  sessionManager: SessionManager,
  db: DB,
  terminalManager?: TerminalManager,
) {
  const clients = new Set<ServerWebSocket<WSData>>();

  // Forward messages from session manager to subscribed WS clients
  sessionManager.onMessage((threadId: string, msg: MessageRow) => {
    const payload: WSServerMessage = {
      type: "message",
      message: messageRowToApi(msg),
    };
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.data.subscriptions.has(threadId)) {
        ws.send(json);
      }
    }
  });

  // Forward stream deltas (ephemeral — not persisted)
  sessionManager.onStreamDelta((threadId: string, delta: StreamDelta) => {
    // Strip session_id from turn_end before sending to client
    const clientDelta = delta.deltaType === "turn_end" && delta.text
      ? { ...delta, text: undefined }
      : delta;
    const payload: WSServerMessage = { type: "stream_delta", delta: clientDelta };
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.data.subscriptions.has(threadId)) {
        ws.send(json);
      }
    }
  });

  // Broadcast thread status updates to ALL clients so the sidebar
  // always reflects current state, even for non-subscribed threads.
  sessionManager.onThreadUpdate((thread: ThreadRow) => {
    const payload: WSServerMessage = {
      type: "thread_updated",
      thread: threadRowToApi(thread),
    };
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      ws.send(json);
    }
  });

  // Forward attention events to ALL connected clients (inbox is cross-thread)
  sessionManager.onAttention((_threadId: string, attention: AttentionItem) => {
    const payload: WSServerMessage = {
      type: "attention_required",
      attention,
    };
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      ws.send(json);
    }
  });

  // Forward attention resolutions to ALL connected clients (covers REST + WS resolutions)
  sessionManager.onAttentionResolved((attentionId: string, threadId: string) => {
    const payload: WSServerMessage = {
      type: "attention_resolved",
      attentionId,
      threadId,
    };
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      ws.send(json);
    }
  });

  // Forward terminal output to subscribed WS clients
  if (terminalManager) {
    terminalManager.onData((terminalId: string, data: string) => {
      const payload: WSServerMessage = { type: "terminal_output", terminalId, data };
      const json = JSON.stringify(payload);
      for (const ws of clients) {
        if (ws.data.subscriptions.has(terminalId)) {
          ws.send(json);
        }
      }
    });

    terminalManager.onExit((terminalId: string, exitCode: number) => {
      const payload: WSServerMessage = { type: "terminal_exit", terminalId, exitCode };
      const json = JSON.stringify(payload);
      for (const ws of clients) {
        if (ws.data.subscriptions.has(terminalId)) {
          ws.send(json);
        }
      }
    });
  }

  // Handle terminal WS messages (delegated from main switch)
  function handleTerminalMessage(
    ws: ServerWebSocket<WSData>,
    msg: WSClientMessage,
  ): void {
    if (!terminalManager) return;

    switch (msg.type) {
      case "terminal_create": {
        const thread = getThread(db, msg.threadId) as ThreadRow | null;
        if (!thread) {
          ws.send(JSON.stringify({
            type: "terminal_error",
            terminalId: msg.threadId,
            error: "Thread not found",
          } satisfies WSServerMessage));
          return;
        }
        const cwd = thread.worktree || thread.repo_path;
        try {
          const result = terminalManager.create(msg.threadId, cwd);
          // Subscribe this WS client to terminal output for this thread
          ws.data.subscriptions.add(msg.threadId);
          const replay = result.reconnect
            ? terminalManager.getReplayBuffer(msg.threadId) ?? undefined
            : undefined;
          ws.send(JSON.stringify({
            type: "terminal_created",
            terminalId: msg.threadId,
            threadId: msg.threadId,
            reconnect: result.reconnect || undefined,
            replay,
          } satisfies WSServerMessage));
        } catch (err) {
          ws.send(JSON.stringify({
            type: "terminal_error",
            terminalId: msg.threadId,
            error: (err as Error).message,
          } satisfies WSServerMessage));
        }
        break;
      }
      case "terminal_input":
        if (!ws.data.subscriptions.has(msg.terminalId)) return;
        terminalManager.write(msg.terminalId, msg.data);
        break;
      case "terminal_resize":
        if (!ws.data.subscriptions.has(msg.terminalId)) return;
        terminalManager.resize(msg.terminalId, msg.cols, msg.rows);
        break;
      case "terminal_close":
        if (!ws.data.subscriptions.has(msg.terminalId)) return;
        terminalManager.close(msg.terminalId);
        ws.data.subscriptions.delete(msg.terminalId);
        break;
    }
  }

  return {
    open(ws: ServerWebSocket<WSData>) {
      ws.data = { subscriptions: new Set() };
      clients.add(ws);
    },

    close(ws: ServerWebSocket<WSData>) {
      clients.delete(ws);
    },

    message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
      let msg: WSClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }

      switch (msg.type) {
        case "subscribe": {
          ws.data.subscriptions.add(msg.threadId);
          const thread = getThread(db, msg.threadId);
          if (thread) {
            ws.send(
              JSON.stringify({
                type: "thread_updated",
                thread: threadRowToApi(thread),
              } satisfies WSServerMessage),
            );
          }
          // Replay missed messages
          const missed = getMessages(db, msg.threadId, msg.lastSeq ?? 0);
          for (const m of missed) {
            ws.send(
              JSON.stringify({
                type: "message",
                message: messageRowToApi(m),
              } satisfies WSServerMessage),
            );
          }
          // Replay pending attention items for this thread
          const pendingAttention = getPendingAttention(db, msg.threadId);
          for (const a of pendingAttention) {
            ws.send(
              JSON.stringify({
                type: "attention_required",
                attention: attentionRowToApi(a),
              } satisfies WSServerMessage),
            );
          }

          ws.send(
            JSON.stringify({
              type: "replay_done",
              threadId: msg.threadId,
            } satisfies WSServerMessage),
          );
          break;
        }

        case "unsubscribe":
          ws.data.subscriptions.delete(msg.threadId);
          break;

        case "send_message":
          try {
            sessionManager.sendMessage(msg.threadId, msg.content, msg.attachments);
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: "error",
                error: (err as Error).message,
              } satisfies WSServerMessage),
            );
          }
          break;

        case "stop_thread":
          sessionManager.stopThread(msg.threadId);
          break;

        case "resolve_attention": {
          // resolveAttention is async (setPermissionMode for ExitPlanMode approval)
          sessionManager.resolveAttention(msg.attentionId, msg.resolution).then((resolved) => {
            if (!resolved) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: `Attention item ${msg.attentionId} not found`,
                } satisfies WSServerMessage),
              );
            }
          }).catch((err) => {
            console.error(`[ws] Failed to resolve attention ${msg.attentionId}:`, err);
          });
          break;
        }

        case "ping":
          // Client keepalive — no response needed, the message itself resets idle timer
          break;

        case "terminal_create":
        case "terminal_input":
        case "terminal_resize":
        case "terminal_close":
          handleTerminalMessage(ws, msg);
          break;
      }
    },
  };
}
