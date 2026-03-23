import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { timingSafeEqual } from "crypto";
import { nanoid } from "nanoid";

function resolveDataDir(dataDir?: string): string {
  return dataDir || join(process.env.HOME || "~", ".orchestra");
}

export function getOrCreateToken(dataDir?: string): string {
  const dir = resolveDataDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, "auth-token");

  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token) return token;
  }

  const token = nanoid(48);
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function regenerateToken(dataDir?: string): string {
  const dir = resolveDataDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, "auth-token");
  const token = nanoid(48);
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function readToken(dataDir?: string): string | null {
  const tokenPath = join(resolveDataDir(dataDir), "auth-token");
  try {
    return readFileSync(tokenPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the request is from localhost (auth not required).
 */
export function isLocalRequest(req: Request, ip: unknown): boolean {
  const remoteAddr =
    typeof ip === "object" && ip !== null && "address" in ip
      ? (ip as { address: string }).address
      : null;

  if (!remoteAddr) return false; // Can't determine — require auth to be safe
  return (
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1" ||
    remoteAddr === "localhost"
  );
}

/**
 * Validates the bearer token from the Authorization header.
 */
export function validateToken(req: Request, expectedToken: string): boolean {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;
  const [scheme, token] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer") return false;
  if (!token) return false;
  return safeCompare(token, expectedToken);
}

/**
 * Validates the token from a WebSocket URL query parameter.
 * WebSocket clients can pass ?token=<token> since they can't set headers easily.
 */
export function validateWSToken(url: URL, expectedToken: string): boolean {
  const token = url.searchParams.get("token");
  if (!token) return false;
  return safeCompare(token, expectedToken);
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
