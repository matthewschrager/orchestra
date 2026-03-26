import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TailscaleDetector } from "../detector";

// Mock Bun.spawn and Bun.spawnSync to avoid real subprocess calls
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

function mockCli(opts: {
  whichResult?: number;
  statusJson?: object | null;
  statusExitCode?: number;
  serveJson?: object | null;
  serveExitCode?: number;
}) {
  // @ts-ignore — mocking Bun.spawnSync
  Bun.spawnSync = (_args: string[]) => {
    if (_args[0] === "which") {
      return { exitCode: opts.whichResult ?? 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }
    return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") };
  };

  // @ts-ignore — mocking Bun.spawn
  Bun.spawn = (_args: string[]) => {
    const cmd = (_args as string[]).join(" ");

    if (cmd.includes("serve") && cmd.includes("status")) {
      const text = opts.serveJson ? JSON.stringify(opts.serveJson) : "";
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(opts.serveExitCode ?? 0),
      };
    }

    if (cmd.includes("status") && cmd.includes("--json")) {
      const text = opts.statusJson ? JSON.stringify(opts.statusJson) : "";
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(opts.statusExitCode ?? 0),
      };
    }

    // version check for absolute paths
    return {
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(1),
    };
  };
}

function restoreMocks() {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
}

describe("TailscaleDetector", () => {
  beforeEach(() => {
    restoreMocks();
  });

  test("returns installed=false when CLI not found", async () => {
    mockCli({ whichResult: 1 });
    const detector = new TailscaleDetector(3847);
    const status = await detector.detect();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.ip).toBeNull();
    restoreMocks();
  });

  test("parses tailscale status --json correctly", async () => {
    mockCli({
      statusJson: {
        Self: {
          TailscaleIPs: ["100.85.42.17", "fd7a:115c:a1e0::1"],
          DNSName: "macbook.tail1234.ts.net.",
          Online: true,
        },
        MagicDNSSuffix: "tail1234.ts.net",
      },
    });
    const detector = new TailscaleDetector(3847);
    const status = await detector.detect();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.ip).toBe("100.85.42.17");
    expect(status.hostname).toBe("macbook.tail1234.ts.net");
    restoreMocks();
  });

  test("prefers IPv4 over IPv6", async () => {
    mockCli({
      statusJson: {
        Self: {
          TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.0.1"],
          DNSName: "test.ts.net.",
        },
      },
    });
    const detector = new TailscaleDetector(3847);
    const status = await detector.detect();
    expect(status.ip).toBe("100.64.0.1");
    restoreMocks();
  });

  test("handles status exit code non-zero", async () => {
    mockCli({ statusExitCode: 1, statusJson: null });
    const detector = new TailscaleDetector(3847);
    const status = await detector.detect();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    restoreMocks();
  });

  test("handles malformed JSON gracefully", async () => {
    // Override spawn to return invalid JSON
    // @ts-ignore
    Bun.spawnSync = () => ({ exitCode: 0 });
    // @ts-ignore
    Bun.spawn = () => ({
      stdout: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("not-json")); c.close(); },
      }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    });
    const detector = new TailscaleDetector(3847);
    const status = await detector.detect();
    expect(status.installed).toBe(true);
    // Should not crash — returns what we have
    restoreMocks();
  });

  test("cache returns same result within TTL", async () => {
    let callCount = 0;
    mockCli({
      statusJson: {
        Self: { TailscaleIPs: ["100.1.2.3"], DNSName: "a.ts.net." },
      },
    });
    const origSpawn = Bun.spawn;
    // @ts-ignore
    const wrappedSpawn = Bun.spawn;
    // @ts-ignore
    Bun.spawn = (...args: any[]) => {
      callCount++;
      // @ts-ignore
      return wrappedSpawn(...args);
    };

    const detector = new TailscaleDetector(3847, 60_000); // 60s cache
    await detector.detect();
    const firstCalls = callCount;
    await detector.detect(); // Should use cache
    expect(callCount).toBe(firstCalls); // No additional subprocess calls
    restoreMocks();
  });

  test("refresh() bypasses cache", async () => {
    let callCount = 0;
    mockCli({
      statusJson: {
        Self: { TailscaleIPs: ["100.1.2.3"], DNSName: "a.ts.net." },
      },
    });
    const wrappedSpawn = Bun.spawn;
    // @ts-ignore
    Bun.spawn = (...args: any[]) => {
      callCount++;
      // @ts-ignore
      return wrappedSpawn(...args);
    };

    const detector = new TailscaleDetector(3847, 60_000);
    await detector.detect();
    const firstCalls = callCount;
    await detector.refresh(); // Should bypass cache
    expect(callCount).toBeGreaterThan(firstCalls);
    restoreMocks();
  });
});
