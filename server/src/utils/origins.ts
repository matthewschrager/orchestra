import { getSetting } from "../db/index.js";
import type { Database } from "bun:sqlite";

type DB = Database;

/** Centralized allowed-origins list used by CORS, Origin validation, Host validation, and WS Origin check */
export function getAllowedOrigins(
  port: number,
  db: DB,
  tunnelManager?: { url: string | null },
  tailscaleHostname?: string | null,
): string[] {
  const origins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  // Dev: Vite dev server
  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:5173", "http://127.0.0.1:5173");
  }
  // Tunnel URL (async -- null until ready)
  const tunnelUrl = tunnelManager?.url;
  if (tunnelUrl) origins.push(tunnelUrl.replace(/\/$/, ""));
  // Tailscale HTTPS
  if (tailscaleHostname) origins.push(`https://${tailscaleHostname}`);
  // User-configured remote URL
  const remoteUrl = getSetting(db, "remoteUrl") as string | null;
  if (remoteUrl) origins.push(remoteUrl.replace(/\/$/, ""));
  return origins;
}

/** Allowed hostnames for Host header validation (DNS rebinding protection) */
export function getAllowedHosts(tailscaleHostname?: string | null): string[] {
  const hosts = ["localhost", "127.0.0.1"];
  if (tailscaleHostname) hosts.push(tailscaleHostname);
  return hosts;
}
