import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { nanoid } from "nanoid";

const SESSION_COOKIE_NAME = "orchestra_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TAILSCALE_DOMAIN_SUFFIX = ".ts.net";

type LoopbackLike = { address: string };

export type AuthDecisionType =
  | "local_direct"
  | "tailscale_bootstrap"
  | "tailscale_tagged_fallback"
  | "session_authenticated"
  | "bearer_authenticated"
  | "unauthenticated";

export interface TailscaleIdentity {
  login: string;
  name: string | null;
  profilePic: string | null;
}

interface SessionPayload {
  provider: "tailscale";
  login: string;
  name: string | null;
  profilePic: string | null;
  iat: number;
  exp: number;
}

export interface AuthDecision {
  type: AuthDecisionType;
  session?: SessionPayload;
  identity?: TailscaleIdentity;
}

export interface AuthConfig {
  authToken: string;
  sessionSecret: string;
  tailscaleHostname?: string | null;
  remoteUrl?: string | null;
}

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

export function getOrCreateSessionSecret(dataDir?: string): string {
  const dir = resolveDataDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const secretPath = join(dir, "session-secret");

  if (existsSync(secretPath)) {
    const secret = readFileSync(secretPath, "utf-8").trim();
    if (secret) return secret;
  }

  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function getRemoteAddress(ip: unknown): string | null {
  if (typeof ip === "object" && ip !== null && "address" in ip) {
    return (ip as LoopbackLike).address;
  }
  return null;
}

export function isLoopbackAddress(address: string | null): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

export function isLocalRequest(_req: Request, ip: unknown): boolean {
  return isLoopbackAddress(getRemoteAddress(ip));
}

export function getRequestHost(req: Request): string | null {
  const host = req.headers.get("host")?.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    return closingBracket === -1 ? null : host.slice(1, closingBracket);
  }
  return host.split(":")[0] ?? null;
}

function isDirectLocalhostHost(host: string | null): boolean {
  return host === "localhost" || host === "127.0.0.1";
}

function getRemoteUrlHost(remoteUrl?: string | null): string | null {
  if (!remoteUrl) return null;
  try {
    return new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isCandidateTailscaleHost(host: string | null, tailscaleHostname?: string | null, remoteUrl?: string | null): boolean {
  if (!host) return false;
  if (tailscaleHostname && host === tailscaleHostname.toLowerCase()) return true;
  const remoteHost = getRemoteUrlHost(remoteUrl);
  return !!remoteHost && remoteHost.endsWith(TAILSCALE_DOMAIN_SUFFIX) && host === remoteHost;
}

function getTailscaleIdentity(req: Request): TailscaleIdentity | null {
  const login = req.headers.get("Tailscale-User-Login");
  if (!login) return null;
  return {
    login,
    name: req.headers.get("Tailscale-User-Name"),
    profilePic: req.headers.get("Tailscale-User-Profile-Pic"),
  };
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const pairs = header.split(";");
  const cookies: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function signValue(payloadBase64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}

function encodeSession(payload: SessionPayload, secret: string): string {
  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signValue(base64, secret);
  return `${base64}.${signature}`;
}

function decodeSession(raw: string, secret: string): SessionPayload | null {
  const [base64, signature] = raw.split(".", 2);
  if (!base64 || !signature) return null;

  const expected = signValue(base64, secret);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(base64, "base64url").toString("utf-8")) as SessionPayload;
    if (parsed.provider !== "tailscale") return null;
    if (!parsed.login || typeof parsed.login !== "string") return null;
    if (!parsed.exp || Date.now() >= parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readSessionFromRequest(req: Request, secret: string): SessionPayload | null {
  const cookies = parseCookieHeader(req.headers.get("cookie"));
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;
  return decodeSession(raw, secret);
}

export function setTailscaleSessionCookie(
  c: Parameters<MiddlewareHandler>[0],
  identity: TailscaleIdentity,
  secret: string,
): void {
  const now = Date.now();
  const payload: SessionPayload = {
    provider: "tailscale",
    login: identity.login,
    name: identity.name,
    profilePic: identity.profilePic,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  setCookie(c, SESSION_COOKIE_NAME, encodeSession(payload, secret), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function hasValidSessionCookie(
  c: Parameters<MiddlewareHandler>[0],
  secret: string,
): boolean {
  const raw = getCookie(c, SESSION_COOKIE_NAME);
  if (!raw) return false;
  return decodeSession(raw, secret) !== null;
}

export function validateToken(req: Request, expectedToken: string): boolean {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;
  const [scheme, token] = authHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer") return false;
  if (!token) return false;
  return safeCompare(token, expectedToken);
}

export function validateWSToken(url: URL, expectedToken: string): boolean {
  const token = url.searchParams.get("token");
  if (!token) return false;
  return safeCompare(token, expectedToken);
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function classifyRequest(req: Request, ip: unknown, config: AuthConfig): AuthDecision {
  const host = getRequestHost(req);
  const remoteAddr = getRemoteAddress(ip);
  const isLoopback = isLoopbackAddress(remoteAddr);
  const identity = getTailscaleIdentity(req);
  const session = readSessionFromRequest(req, config.sessionSecret);
  const tailscaleHost = isCandidateTailscaleHost(host, config.tailscaleHostname, config.remoteUrl);

  if (session) {
    return { type: "session_authenticated", session };
  }

  if (validateToken(req, config.authToken)) {
    return { type: "bearer_authenticated" };
  }

  if (isLoopback && isDirectLocalhostHost(host) && !tailscaleHost) {
    return { type: "local_direct" };
  }

  if (isLoopback && tailscaleHost && identity) {
    return { type: "tailscale_bootstrap", identity };
  }

  if (isLoopback && tailscaleHost && !identity) {
    return { type: "tailscale_tagged_fallback" };
  }

  return { type: "unauthenticated" };
}

export function shouldAttemptTailscaleHostRefresh(host: string | null, ip: unknown, tailscaleHostname?: string | null): boolean {
  if (tailscaleHostname || !host || !host.endsWith(TAILSCALE_DOMAIN_SUFFIX)) return false;
  return isLoopbackAddress(getRemoteAddress(ip));
}

export function shouldBootstrapSession(req: Request, decision: AuthDecision): boolean {
  if (decision.type !== "tailscale_bootstrap") return false;
  if (!decision.identity) return false;
  if (!["GET", "HEAD"].includes(req.method)) return false;

  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return false;

  const accept = req.headers.get("accept") || "";
  const fetchDest = req.headers.get("sec-fetch-dest") || "";
  return accept.includes("text/html") || fetchDest === "document" || url.pathname === "/";
}

export function createApiAuthMiddleware(configProvider: () => AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const decision = classifyRequest(c.req.raw, (c as any).env?.ip, configProvider());

    if (decision.type === "local_direct" || decision.type === "session_authenticated" || decision.type === "bearer_authenticated") {
      await next();
      return;
    }

    if (decision.type === "tailscale_tagged_fallback") {
      return c.json({ error: "Unauthorized — tagged Tailscale access requires Bearer token" }, 401);
    }

    return c.json({ error: "Unauthorized — provide Bearer token" }, 401);
  };
}

export function createTailscaleBootstrapMiddleware(configProvider: () => AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const config = configProvider();
    const decision = classifyRequest(c.req.raw, (c as any).env?.ip, config);

    if (shouldBootstrapSession(c.req.raw, decision) && decision.identity && !hasValidSessionCookie(c, config.sessionSecret)) {
      setTailscaleSessionCookie(c, decision.identity, config.sessionSecret);
    }

    await next();
  };
}

export function createHostValidationMiddleware(opts: {
  getAllowedHosts: () => string[],
  getTailscaleHostname: () => string | null | undefined,
  refreshTailscaleHostname?: () => Promise<string | null>,
}): MiddlewareHandler {
  return async (c, next) => {
    const host = getRequestHost(c.req.raw);
    if (host) {
      let allowed = opts.getAllowedHosts();
      if (!allowed.includes(host) && shouldAttemptTailscaleHostRefresh(host, (c as any).env?.ip, opts.getTailscaleHostname())) {
        const refreshed = await opts.refreshTailscaleHostname?.();
        if (refreshed) {
          allowed = opts.getAllowedHosts();
        }
      }
      if (!allowed.includes(host)) {
        return c.text("Invalid Host", 403);
      }
    }
    await next();
  };
}

export function isWebSocketAuthorized(url: URL, req: Request, ip: unknown, config: AuthConfig): boolean {
  const decision = classifyRequest(req, ip, config);
  switch (decision.type) {
    case "local_direct":
    case "session_authenticated":
    case "tailscale_bootstrap":
      return true;
    case "bearer_authenticated":
      return true;
    case "tailscale_tagged_fallback":
      return validateWSToken(url, config.authToken);
    case "unauthenticated":
      return validateWSToken(url, config.authToken);
  }
}
