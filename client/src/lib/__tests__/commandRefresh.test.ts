import { describe, expect, test } from "bun:test";
import {
  COMMAND_REFRESH_MAX_AGE_MS,
  getCommandsCacheKey,
  shouldRefreshCommands,
} from "../commandRefresh";

describe("commandRefresh", () => {
  test("uses a stable key for global commands", () => {
    expect(getCommandsCacheKey(null)).toBe("__global__");
  });

  test("uses project id as cache key when present", () => {
    expect(getCommandsCacheKey("proj-1")).toBe("proj-1");
  });

  test("refreshes when commands have never been fetched", () => {
    expect(shouldRefreshCommands(undefined, 1_000)).toBe(true);
  });

  test("does not refresh within the freshness window", () => {
    expect(shouldRefreshCommands(1_000, 1_000 + COMMAND_REFRESH_MAX_AGE_MS - 1)).toBe(false);
  });

  test("refreshes once the freshness window expires", () => {
    expect(shouldRefreshCommands(1_000, 1_000 + COMMAND_REFRESH_MAX_AGE_MS)).toBe(true);
  });
});
