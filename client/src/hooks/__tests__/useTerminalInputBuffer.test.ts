import { describe, expect, test, beforeEach, afterEach, jest } from "bun:test";

/**
 * Tests for the terminal input batching logic in useTerminal's sendInput().
 *
 * The hook batches printable keystrokes into a 16ms buffer and flushes as a
 * single WS message. Control characters (Ctrl+C, Ctrl+D) and escape sequences
 * (arrow keys, etc.) bypass the buffer and send immediately.
 */

// Minimal reproduction of the sendInput buffering logic, extracted for testability.
// Mirrors the exact pattern from useTerminal.ts sendInput().
function createInputBuffer(send: (data: string) => void) {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let terminalId: string | null = null;

  return {
    setTerminalId(id: string | null) {
      terminalId = id;
    },
    sendInput(data: string) {
      if (!terminalId) return;

      // Control characters and escape sequences bypass the buffer
      const isControl = data.length === 1 && data.charCodeAt(0) < 32;
      const isEscape = data.length > 0 && data.charCodeAt(0) === 0x1b;
      if (isControl || isEscape) {
        // Flush any pending buffer first so ordering is preserved
        if (buffer) {
          const buffered = buffer;
          buffer = "";
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          send(buffered);
        }
        send(data);
        return;
      }

      buffer += data;
      if (!timer) {
        timer = setTimeout(() => {
          const buffered = buffer;
          buffer = "";
          timer = null;
          if (buffered && terminalId) {
            send(buffered);
          }
        }, 16);
      }
    },
    cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      buffer = "";
    },
    // Expose internals for testing
    get pendingBuffer() { return buffer; },
    get hasTimer() { return timer !== null; },
  };
}

describe("useTerminal input buffer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("does nothing when no terminalId is set", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.sendInput("a");
    jest.advanceTimersByTime(20);
    expect(sent).toEqual([]);
    expect(buf.pendingBuffer).toBe("");
  });

  test("batches rapid keystrokes into a single send", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("h");
    buf.sendInput("e");
    buf.sendInput("l");
    buf.sendInput("l");
    buf.sendInput("o");

    expect(sent).toEqual([]);
    expect(buf.pendingBuffer).toBe("hello");
    expect(buf.hasTimer).toBe(true);

    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["hello"]);
    expect(buf.pendingBuffer).toBe("");
    expect(buf.hasTimer).toBe(false);
  });

  test("first keystroke starts a timer, subsequent ones reuse it", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("a");
    expect(buf.hasTimer).toBe(true);

    buf.sendInput("b");
    buf.sendInput("c");
    expect(buf.pendingBuffer).toBe("abc");

    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["abc"]);
  });

  test("consecutive batches flush independently", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("hello");
    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["hello"]);

    buf.sendInput(" world");
    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["hello", " world"]);
  });

  test("flush skips send if terminalId becomes null before timer fires", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("data");
    buf.setTerminalId(null);
    jest.advanceTimersByTime(16);

    expect(sent).toEqual([]);
  });

  test("cleanup clears pending timer and buffer", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("pending data");
    expect(buf.hasTimer).toBe(true);
    expect(buf.pendingBuffer).toBe("pending data");

    buf.cleanup();
    expect(buf.hasTimer).toBe(false);
    expect(buf.pendingBuffer).toBe("");

    jest.advanceTimersByTime(20);
    expect(sent).toEqual([]);
  });

  test("handles empty string input gracefully", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("");
    jest.advanceTimersByTime(16);

    expect(sent).toEqual([]);
  });

  // Control character bypass tests

  test("Ctrl+C (0x03) is sent immediately, not buffered", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("\x03"); // Ctrl+C
    // Sent immediately — no need to advance timers
    expect(sent).toEqual(["\x03"]);
    expect(buf.pendingBuffer).toBe("");
    expect(buf.hasTimer).toBe(false);
  });

  test("Ctrl+D (0x04) is sent immediately", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("\x04"); // Ctrl+D (EOF)
    expect(sent).toEqual(["\x04"]);
  });

  test("Enter (0x0d) is sent immediately", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("\r"); // Enter / carriage return
    expect(sent).toEqual(["\r"]);
  });

  test("escape sequence (arrow keys) bypasses buffer", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("\x1b[A"); // Up arrow
    expect(sent).toEqual(["\x1b[A"]);
  });

  test("control char flushes pending buffer first to preserve ordering", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    // Type some characters...
    buf.sendInput("hel");
    expect(buf.pendingBuffer).toBe("hel");

    // ...then Ctrl+C — buffer should flush first, then Ctrl+C
    buf.sendInput("\x03");
    expect(sent).toEqual(["hel", "\x03"]);
    expect(buf.pendingBuffer).toBe("");
    expect(buf.hasTimer).toBe(false); // timer was cleared
  });

  test("control chars with no pending buffer just send directly", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("\x03");
    buf.sendInput("\x03");
    buf.sendInput("\x03");
    expect(sent).toEqual(["\x03", "\x03", "\x03"]);
  });

  test("printable chars after control char resume normal batching", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("\x03"); // immediate
    buf.sendInput("a");    // buffered
    buf.sendInput("b");    // buffered

    expect(sent).toEqual(["\x03"]);
    expect(buf.pendingBuffer).toBe("ab");

    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["\x03", "ab"]);
  });
});
