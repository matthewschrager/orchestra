import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { WSServerMessage } from "shared";

// ── Theme ──────────────────────────────────────────────

const ORCHESTRA_TERMINAL_THEME = {
  background: "#0e0e14",
  foreground: "#e8e4df",
  cursor: "#22d3ee",
  cursorAccent: "#0e0e14",
  selectionBackground: "#22d3ee33",
  selectionForeground: "#e8e4df",
  black: "#08080d",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e8e4df",
  brightBlack: "#3a3a4a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

// ── Constants ──────────────────────────────────────────

const MIN_HEIGHT = 80;
const MAX_HEIGHT_RATIO = 0.7;
const STORAGE_KEY = "orchestra:terminal-height";

function getStoredHeight(): number | null {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (!val) return null;
    const n = parseInt(val, 10);
    if (isNaN(n) || n < MIN_HEIGHT) return null;
    return n;
  } catch {
    return null;
  }
}

// ── Props ──────────────────────────────────────────────

interface TerminalPanelProps {
  threadId: string;
  visible: boolean;
  connected: boolean;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
  replay: string | null;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onRestart: () => void;
  onClose: () => void;
  /** Raw WS messages — we filter for terminal_output */
  lastMessage: WSServerMessage | null;
}

export function TerminalPanel({
  threadId,
  visible,
  connected,
  exited,
  exitCode,
  error,
  replay,
  onInput,
  onResize,
  onRestart,
  onClose,
  lastMessage,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [height, setHeight] = useState(() => getStoredHeight() ?? 200);
  const [dragging, setDragging] = useState(false);
  const [animating, setAnimating] = useState(false);
  const prevVisibleRef = useRef(visible);
  const prevThreadIdRef = useRef(threadId);

  // ── Initialize xterm.js ────────────────────────────────

  useEffect(() => {
    if (!visible || !containerRef.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Menlo', monospace",
      cursorBlink: true,
      cursorStyle: "bar",
      theme: ORCHESTRA_TERMINAL_THEME,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    // WebGL with DOM fallback
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer fallback
    }

    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Forward input to server
    term.onData((data) => onInput(data));

    // ResizeObserver for auto-fit
    const ro = new ResizeObserver(() => {
      if (fitRef.current && termRef.current) {
        fitRef.current.fit();
        onResize(termRef.current.cols, termRef.current.rows);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [threadId, visible]); // Re-create xterm instance when thread changes or panel opens

  // ── Handle replay buffer on reconnect ──────────────────

  useEffect(() => {
    if (replay && termRef.current) {
      termRef.current.write(replay);
    }
  }, [replay]);

  // ── Handle incoming terminal output ────────────────────

  useEffect(() => {
    if (
      lastMessage &&
      lastMessage.type === "terminal_output" &&
      lastMessage.terminalId === threadId &&
      termRef.current
    ) {
      termRef.current.write(lastMessage.data);
    }
  }, [lastMessage, threadId]);

  // ── Handle visibility toggle animation ─────────────────

  useEffect(() => {
    if (prevVisibleRef.current !== visible) {
      prevVisibleRef.current = visible;
      if (visible) {
        setAnimating(true);
        // After transition, fit and show
        const timer = setTimeout(() => {
          setAnimating(false);
          fitRef.current?.fit();
          termRef.current?.focus();
        }, 220);
        return () => clearTimeout(timer);
      }
    }
  }, [visible]);

  // ── Fit on height change ──────────────────────────────

  useEffect(() => {
    if (visible && !animating) {
      const timer = setTimeout(() => {
        fitRef.current?.fit();
        if (termRef.current) {
          onResize(termRef.current.cols, termRef.current.rows);
        }
      }, 20);
      return () => clearTimeout(timer);
    }
  }, [height, visible, animating, onResize]);

  // ── Clear terminal on thread switch ───────────────────

  useEffect(() => {
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId;
      if (termRef.current) {
        termRef.current.clear();
        termRef.current.reset();
      }
    }
  }, [threadId]);

  // ── Drag resize ───────────────────────────────────────

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      setDragging(true);

      const maxH = window.innerHeight * MAX_HEIGHT_RATIO;
      let lastHeight = startHeight;

      const onMove = (ev: PointerEvent) => {
        // Dragging up = increasing height (startY - ev.clientY is positive)
        const delta = startY - ev.clientY;
        const newHeight = Math.max(MIN_HEIGHT, Math.min(maxH, startHeight + delta));
        lastHeight = newHeight;
        setHeight(newHeight);
      };

      const onUp = () => {
        setDragging(false);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("lostpointercapture", onUp);
        // Persist final dragged height (not the stale closure value)
        localStorage.setItem(STORAGE_KEY, String(lastHeight));
        fitRef.current?.fit();
        if (termRef.current) {
          onResize(termRef.current.cols, termRef.current.rows);
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("lostpointercapture", onUp);
    },
    [height, onResize],
  );

  // ── Render ────────────────────────────────────────────

  if (!visible) return null;

  const maxH = typeof window !== "undefined" ? window.innerHeight * MAX_HEIGHT_RATIO : 500;
  const clampedHeight = Math.max(MIN_HEIGHT, Math.min(maxH, height));

  return (
    <div
      className="hidden md:block shrink-0"
      style={{
        height: clampedHeight,
        transition: animating ? "height 200ms ease-out" : undefined,
      }}
    >
      {/* Drag handle */}
      <div
        className="h-1 cursor-ns-resize border-t border-edge-2 hover:border-accent/50 active:border-accent"
        onPointerDown={handleDragStart}
      />

      {/* Terminal header bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-surface-1 border-b border-edge-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-content-3">
            {connected ? "bash" : "terminal"}
          </span>
          {connected && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          )}
        </div>
        <button
          onClick={onClose}
          className="text-content-3 hover:text-content-1 px-1.5 py-0.5 hover:bg-surface-3 rounded text-xs"
          title="Close terminal"
        >
          ×
        </button>
      </div>

      {/* Terminal body */}
      <div
        className="relative"
        style={{
          height: `calc(100% - 30px)`,
          visibility: animating ? "hidden" : "visible",
        }}
      >
        {/* xterm.js container */}
        <div
          ref={containerRef}
          className="w-full h-full bg-[#0e0e14]"
          style={{
            pointerEvents: dragging ? "none" : "auto",
          }}
        />

        {/* Overlay states */}
        {!connected && !error && !exited && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0e0e14]">
            <span className="text-content-3 text-sm animate-pulse">
              Connecting...
            </span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0e0e14] gap-3">
            <span className="text-red-400 text-sm">{error}</span>
            <button
              onClick={onRestart}
              className="px-3 py-1.5 bg-surface-3 hover:bg-surface-2 rounded text-sm text-content-2 hover:text-content-1"
            >
              Retry
            </button>
          </div>
        )}

        {exited && (
          <div className="absolute bottom-0 inset-x-0 flex items-center justify-center gap-3 py-2 bg-surface-1/80 backdrop-blur-sm">
            <span className="text-content-3 text-sm">
              Process exited with code {exitCode}
            </span>
            <button
              onClick={() => {
                termRef.current?.clear();
                termRef.current?.reset();
                onRestart();
              }}
              className="px-3 py-1 bg-surface-3 hover:bg-surface-2 rounded text-sm text-content-2 hover:text-content-1"
            >
              Restart
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
