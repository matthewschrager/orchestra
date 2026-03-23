import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { nanoid } from "nanoid";

const ORCHESTRA_DIR = join(process.env.HOME || "~", ".orchestra");
const TOKEN_PATH = join(ORCHESTRA_DIR, "auth-token");

export function getOrCreateToken(): string {
  mkdirSync(ORCHESTRA_DIR, { recursive: true });

  if (existsSync(TOKEN_PATH)) {
    const token = readFileSync(TOKEN_PATH, "utf-8").trim();
    if (token) return token;
  }

  const token = nanoid(48);
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export function regenerateToken(): string {
  mkdirSync(ORCHESTRA_DIR, { recursive: true });
  const token = nanoid(48);
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export function readToken(): string | null {
  try {
    return readFileSync(TOKEN_PATH, "utf-8").trim() || null;
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

  if (!remoteAddr) return true; // Can't determine — assume local
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
  return token === expectedToken;
}

/**
 * Validates the token from a WebSocket URL query parameter.
 * WebSocket clients can pass ?token=<token> since they can't set headers easily.
 */
export function validateWSToken(url: URL, expectedToken: string): boolean {
  const token = url.searchParams.get("token");
  return token === expectedToken;
}
