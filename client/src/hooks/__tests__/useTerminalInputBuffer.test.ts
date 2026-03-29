import { describe, expect, test, beforeEach, afterEach, jest } from "bun:test";

/**
 * Tests for the terminal input batching logic in useTerminal's sendInput().
 *
 * The hook batches keystrokes into a 16ms buffer and flushes as a single WS
 * message. We test the core buffering behavior by simulating the same pattern
 * the hook uses: accumulate into a string buffer, schedule a flush via
 * setTimeout, and verify that opts.send() is called with the batched data.
 */

// Minimal reproduction of the sendInput buffering logic, extracted for testability.
// Mirrors the exact pattern from useTerminal.ts lines 100-116.
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
    // terminalId is null by default
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

    // Before timer fires: nothing sent yet, buffer has all chars
    expect(sent).toEqual([]);
    expect(buf.pendingBuffer).toBe("hello");
    expect(buf.hasTimer).toBe(true);

    // After 16ms: single batched send
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
    // Still the same timer, not three timers
    expect(buf.pendingBuffer).toBe("abc");

    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["abc"]);
  });

  test("consecutive batches flush independently", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    // First batch
    buf.sendInput("hello");
    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["hello"]);

    // Second batch (new timer)
    buf.sendInput(" world");
    jest.advanceTimersByTime(16);
    expect(sent).toEqual(["hello", " world"]);
  });

  test("flush skips send if terminalId becomes null before timer fires", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("data");
    buf.setTerminalId(null); // terminal disconnected
    jest.advanceTimersByTime(16);

    // Buffer was flushed but send was skipped (no terminalId)
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

    // Timer was cleared, so advancing time should not send
    jest.advanceTimersByTime(20);
    expect(sent).toEqual([]);
  });

  test("handles empty string input gracefully", () => {
    const sent: string[] = [];
    const buf = createInputBuffer((data) => sent.push(data));
    buf.setTerminalId("term-1");

    buf.sendInput("");
    jest.advanceTimersByTime(16);

    // Empty string is falsy, so send is skipped
    expect(sent).toEqual([]);
  });
});
