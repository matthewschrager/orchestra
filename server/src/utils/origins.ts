import { getSetting } from "../db/index.js";
import type { Database } from "bun:sqlite";
import { networkInterfaces, type NetworkInterfaceInfo } from "os";

type DB = Database;

/** Centralized allowed-origins list used by CORS, Origin validation, Host validation, and WS Origin check */
export function getAllowedOrigins(
  port: number,
  db: DB,
  tunnelManager?: { url: string | null },
  tailscaleHostname?: string | null,
  additionalHosts: string[] = [],
): string[] {
  const origins = new Set<string>();
  for (const host of new Set([...getLocalInterfaceHosts(), ...additionalHosts])) {
    const normalizedHost = normalizeHostCandidate(host);
    if (!normalizedHost || normalizedHost === "0.0.0.0" || normalizedHost === "::") continue;
    origins.add(`http://${formatHostForUrl(normalizedHost)}:${port}`);
  }
  // Dev: Vite dev server
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  // Tunnel URL (async -- null until ready)
  const tunnelUrl = tunnelManager?.url;
  if (tunnelUrl) origins.add(tunnelUrl.replace(/\/$/, ""));
  // Tailscale HTTPS
  if (tailscaleHostname) origins.add(`https://${tailscaleHostname}`);
  // User-configured remote URL
  const remoteUrl = getSetting(db, "remoteUrl") as string | null;
  if (remoteUrl) origins.add(remoteUrl.replace(/\/$/, ""));
  return [...origins];
}

/** Allowed hostnames for Host header validation (DNS rebinding protection) */
export function getAllowedHosts(
  tailscaleHostname?: string | null,
  remoteUrl?: string | null,
  tunnelUrl?: string | null,
  additionalHosts: string[] = [],
): string[] {
  const hosts = new Set(getLocalInterfaceHosts());
  const normalizedTailscaleHost = normalizeHostCandidate(tailscaleHostname);
  if (normalizedTailscaleHost) hosts.add(normalizedTailscaleHost);
  const remoteHost = hostFromUrl(remoteUrl);
  if (remoteHost) hosts.add(remoteHost);
  const tunnelHost = hostFromUrl(tunnelUrl);
  if (tunnelHost) hosts.add(tunnelHost);
  for (const host of additionalHosts) {
    const normalizedHost = normalizeHostCandidate(host);
    if (!normalizedHost || normalizedHost === "0.0.0.0" || normalizedHost === "::") continue;
    hosts.add(normalizedHost);
  }
  return [...hosts];
}

export function getLocalInterfaceHosts(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      const normalizedAddress = normalizeHostCandidate(address.address.split("%")[0]);
      if (!normalizedAddress || normalizedAddress === "0.0.0.0" || normalizedAddress === "::") continue;
      hosts.add(normalizedAddress);
    }
  }
  return [...hosts];
}

function hostFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeHostCandidate(host?: string | null): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    return closingBracket === -1 ? null : trimmed.slice(1, closingBracket);
  }
  return trimmed;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
