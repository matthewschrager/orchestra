import { describe, expect, test } from "bun:test";
import {
  detectPushSupport,
  isAppleMobileDevice,
  isStandaloneDisplayMode,
  type PushSupportEnvironment,
} from "../pushSupport";

function makeEnv(overrides: Partial<PushSupportEnvironment> = {}): PushSupportEnvironment {
  return {
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    isSecureContext: true,
    isAppleMobile: false,
    isStandalone: false,
    ...overrides,
  };
}

describe("detectPushSupport", () => {
  test("reports full support when the required APIs are available", () => {
    expect(detectPushSupport(makeEnv())).toEqual({
      supported: true,
      unsupportedReason: null,
      installHint: null,
    });
  });

  test("explains the HTTPS requirement before other checks", () => {
    expect(detectPushSupport(makeEnv({ isSecureContext: false }))).toEqual({
      supported: false,
      unsupportedReason: "Push notifications require HTTPS when you access Orchestra remotely.",
      installHint: null,
    });
  });

  test("explains the iPhone/iPad home-screen requirement", () => {
    expect(detectPushSupport(makeEnv({
      hasServiceWorker: false,
      hasPushManager: false,
      isAppleMobile: true,
      isStandalone: false,
    }))).toEqual({
      supported: false,
      unsupportedReason: "On iPhone and iPad, push notifications only work after installing Orchestra to your Home Screen.",
      installHint: "Open the Share menu, tap Add to Home Screen, then reopen Orchestra from the installed app.",
    });
  });

  test("falls back to a generic unsupported-browser message", () => {
    expect(detectPushSupport(makeEnv({ hasPushManager: false }))).toEqual({
      supported: false,
      unsupportedReason: "This browser does not expose the APIs needed for web push notifications.",
      installHint: null,
    });
  });
});

describe("isAppleMobileDevice", () => {
  test("detects iPhone user agents", () => {
    expect(isAppleMobileDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      "iPhone",
      5,
    )).toBe(true);
  });

  test("detects iPadOS Safari desktop-class user agents", () => {
    expect(isAppleMobileDevice(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      "MacIntel",
      5,
    )).toBe(true);
  });

  test("does not flag Android devices as Apple mobile", () => {
    expect(isAppleMobileDevice(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
      "Linux armv8l",
      5,
    )).toBe(false);
  });
});

describe("isStandaloneDisplayMode", () => {
  test("returns true when either standalone signal is present", () => {
    expect(isStandaloneDisplayMode(true, false)).toBe(true);
    expect(isStandaloneDisplayMode(false, true)).toBe(true);
  });

  test("returns false when neither standalone signal is present", () => {
    expect(isStandaloneDisplayMode(false, false)).toBe(false);
  });
});
