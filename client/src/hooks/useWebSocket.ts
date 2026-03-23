import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, StreamDelta, Thread, WSClientMessage, WSServerMessage } from "shared";

interface UseWebSocketOpts {
  onMessage?: (msg: Message) => void;
  onThreadUpdate?: (thread: Thread) => void;
  onReplayDone?: (threadId: string) => void;
  onStreamDelta?: (delta: StreamDelta) => void;
  onError?: (error: string) => void;
}

export function useWebSocket(opts: UseWebSocketOpts = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let ws: WebSocket;
    let retryDelay = 1000;
    let closed = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = localStorage.getItem("orchestra_auth_token");
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
      const url = `${protocol}//${window.location.host}/ws${tokenParam}`;
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryDelay = 1000;
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!closed) {
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
      };

      ws.onmessage = (evt) => {
        const data: WSServerMessage = JSON.parse(evt.data);
        switch (data.type) {
          case "message":
            optsRef.current.onMessage?.(data.message);
            break;
          case "thread_updated":
            optsRef.current.onThreadUpdate?.(data.thread);
            break;
          case "replay_done":
            optsRef.current.onReplayDone?.(data.threadId);
            break;
          case "stream_delta":
            optsRef.current.onStreamDelta?.(data.delta);
            break;
          case "error":
            optsRef.current.onError?.(data.error);
            break;
        }
      };
    }

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  const send = useCallback((msg: WSClientMessage) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  return { connected, send };
}
