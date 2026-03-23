import type { ServerWebSocket } from "bun";
import type { DB, MessageRow, ThreadRow } from "../db";
import { getMessages, messageRowToApi, threadRowToApi } from "../db";
import type { SessionManager } from "../sessions/manager";
import type { StreamDelta, WSClientMessage, WSServerMessage } from "shared";

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

  sessionManager.onThreadUpdate((thread: ThreadRow) => {
    const payload: WSServerMessage = {
      type: "thread_updated",
      thread: threadRowToApi(thread),
    };
    const json = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.data.subscriptions.has(thread.id)) {
        ws.send(json);
      }
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
            sessionManager.sendMessage(msg.threadId, msg.content);
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
      }
    },
  };
}
