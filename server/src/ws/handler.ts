import type { ServerWebSocket } from "bun";
import type { DB, MessageRow, ThreadRow } from "../db";
import { getMessages, getPendingAttention, getThread, attentionRowToApi, messageRowToApi, threadRowToApi } from "../db";
import type { SessionManager } from "../sessions/manager";
import type { AttentionItem, StreamDelta, WSClientMessage, WSServerMessage } from "shared";

interface WSData {
  subscriptions: Set<string>;
}

export function createWSHandler(sessionManager: SessionManager, db: DB) {
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
          const resolved = sessionManager.resolveAttention(msg.attentionId, msg.resolution);
          if (!resolved) {
            ws.send(
              JSON.stringify({
                type: "error",
                error: `Attention item ${msg.attentionId} not found`,
              } satisfies WSServerMessage),
            );
          }
          break;
        }

        case "ping":
          // Client keepalive — no response needed, the message itself resets idle timer
          break;
      }
    },
  };
}
