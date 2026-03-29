import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { applySecurityHeaders, CONTENT_SECURITY_POLICY } from "../securityHeaders";

describe("security headers", () => {
  test("allows wasm compilation without enabling general eval", () => {
    expect(CONTENT_SECURITY_POLICY).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    );
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
  });

  test("applies the expected response headers", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      applySecurityHeaders(c);
    });
    app.get("/", (c) => c.text("ok"));

    const res = await app.request("/");

    expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});
