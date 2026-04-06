import { describe, expect, test } from "bun:test";
import { shouldNotifyThreadBecameIdle } from "../thread-status";

describe("shouldNotifyThreadBecameIdle", () => {
  test("does not notify without a previous status", () => {
    expect(shouldNotifyThreadBecameIdle(undefined, "done")).toBe(false);
  });

  test("notifies when a thread transitions into done", () => {
    expect(shouldNotifyThreadBecameIdle("running", "done")).toBe(true);
    expect(shouldNotifyThreadBecameIdle("waiting", "done")).toBe(true);
  });

  test("notifies when a thread transitions into error", () => {
    expect(shouldNotifyThreadBecameIdle("running", "error")).toBe(true);
  });

  test("does not notify for non-terminal transitions", () => {
    expect(shouldNotifyThreadBecameIdle("pending", "running")).toBe(false);
    expect(shouldNotifyThreadBecameIdle("running", "waiting")).toBe(false);
  });

  test("does not notify for repeated terminal updates", () => {
    expect(shouldNotifyThreadBecameIdle("done", "done")).toBe(false);
    expect(shouldNotifyThreadBecameIdle("error", "error")).toBe(false);
  });
});
