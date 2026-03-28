import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDb } from "../db";
import { getAllowedHosts, getAllowedOrigins, getLocalInterfaceHosts } from "../utils/origins";

describe("origin host allowlist", () => {
  test("includes loopback and local interface addresses", () => {
    const hosts = getLocalInterfaceHosts({
      lo: [
        { address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8", mac: "00:00:00:00:00:00", netmask: "255.0.0.0" },
        { address: "::1", family: "IPv6", internal: true, cidr: "::1/128", mac: "00:00:00:00:00:00", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", scopeid: 0 },
      ],
      eth0: [
        { address: "192.168.1.25", family: "IPv4", internal: false, cidr: "192.168.1.25/24", mac: "00:11:22:33:44:55", netmask: "255.255.255.0" },
        { address: "fe80::abcd%eth0", family: "IPv6", internal: false, cidr: "fe80::abcd/64", mac: "00:11:22:33:44:55", netmask: "ffff:ffff:ffff:ffff::", scopeid: 2 },
      ],
    });

    expect(hosts).toContain("localhost");
    expect(hosts).toContain("127.0.0.1");
    expect(hosts).toContain("::1");
    expect(hosts).toContain("192.168.1.25");
    expect(hosts).toContain("fe80::abcd");
  });

  test("merges remote, tunnel, and explicit extra hosts", () => {
    const hosts = getAllowedHosts(
      "qa-node.tail373d97.ts.net",
      "https://remote.example.com/",
      "https://abc123.trycloudflare.com/",
      ["192.168.1.25", "0.0.0.0", "[::1]"],
    );

    expect(hosts).toContain("qa-node.tail373d97.ts.net");
    expect(hosts).toContain("remote.example.com");
    expect(hosts).toContain("abc123.trycloudflare.com");
    expect(hosts).toContain("192.168.1.25");
    expect(hosts).toContain("::1");
    expect(hosts).not.toContain("0.0.0.0");
  });

  test("allows LAN origins for the current port", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "orchestra-origins-test-"));
    const db = createDb(dbDir);
    try {
      const origins = getAllowedOrigins(
        4850,
        db,
        undefined,
        null,
        ["192.168.1.25", "[::1]"],
      );

      expect(origins).toContain("http://192.168.1.25:4850");
      expect(origins).toContain("http://[::1]:4850");
    } finally {
      db.close(false);
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
