import { useCallback, useEffect, useRef, useState } from "react";
import type { WSClientMessage, WSServerMessage } from "shared";

interface UseTerminalReturn {
  terminalId: string | null;
  connected: boolean;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
  replay: string | null;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  restart: () => void;
  handleMessage: (msg: WSServerMessage) => void;
}

export function useTerminal(opts: {
  threadId: string | null;
  visible: boolean;
  send: (msg: WSClientMessage) => void;
}): UseTerminalReturn {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [exited, setExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<string | null>(null);

  // Use refs for values WS callbacks need to read synchronously
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const threadIdRef = useRef(opts.threadId);
  threadIdRef.current = opts.threadId;

  // Request terminal creation when visible + thread changes
  useEffect(() => {
    if (!opts.visible || !opts.threadId) return;

    // Reset state for new thread
    setConnected(false);
    setExited(false);
    setExitCode(null);
    setError(null);
    setReplay(null);

    opts.send({ type: "terminal_create", threadId: opts.threadId });
  }, [opts.threadId, opts.visible, opts.send]);

  // Handle incoming WS messages related to terminal
  const handleMessage = useCallback((msg: WSServerMessage) => {
    switch (msg.type) {
      case "terminal_created":
        if (msg.threadId === threadIdRef.current) {
          setTerminalId(msg.terminalId);
          setConnected(true);
          setExited(false);
          setExitCode(null);
          setError(null);
          setReplay(msg.replay ?? null);
        }
        break;
      case "terminal_output":
        // Handled directly by TerminalPanel via onOutput callback
        break;
      case "terminal_exit":
        if (msg.terminalId === terminalIdRef.current) {
          setExited(true);
          setExitCode(msg.exitCode);
        }
        break;
      case "terminal_error":
        if (
          msg.terminalId === terminalIdRef.current ||
          msg.terminalId === threadIdRef.current
        ) {
          setError(msg.error);
          setConnected(false);
        }
        break;
    }
  }, []);

  const sendInput = useCallback(
    (data: string) => {
      if (terminalIdRef.current) {
        opts.send({ type: "terminal_input", terminalId: terminalIdRef.current, data });
      }
    },
    [opts.send],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (terminalIdRef.current) {
        opts.send({ type: "terminal_resize", terminalId: terminalIdRef.current, cols, rows });
      }
    },
    [opts.send],
  );

  const restart = useCallback(() => {
    if (terminalIdRef.current) {
      opts.send({ type: "terminal_close", terminalId: terminalIdRef.current });
    }
    if (threadIdRef.current) {
      setConnected(false);
      setExited(false);
      setExitCode(null);
      setError(null);
      setReplay(null);
      opts.send({ type: "terminal_create", threadId: threadIdRef.current });
    }
  }, [opts.send]);

  return {
    terminalId,
    connected,
    exited,
    exitCode,
    error,
    replay,
    sendInput,
    resize,
    restart,
    handleMessage,
  };
}
