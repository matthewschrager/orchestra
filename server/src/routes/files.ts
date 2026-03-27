import { Hono } from "hono";
import { extname } from "path";

/** Image extensions safe for inline rendering (SVG excluded — XSS risk via script tags) */
const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

export function createFileRoutes() {
  const app = new Hono();

  app.get("/serve", async (c) => {
    const filePath = c.req.query("path");

    // Must provide a path
    if (!filePath) {
      return c.json({ error: "Missing 'path' query parameter" }, 400);
    }

    // Must be absolute
    if (!filePath.startsWith("/")) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    // No path traversal
    if (filePath.includes("..")) {
      return c.json({ error: "Path traversal not allowed" }, 400);
    }

    // Extension allowlist
    const ext = extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return c.json({ error: `Extension '${ext}' not allowed` }, 403);
    }

    // Check file exists
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return c.json({ error: "File not found" }, 404);
    }

    const contentType = file.type || "application/octet-stream";

    return new Response(file.stream(), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return app;
}
