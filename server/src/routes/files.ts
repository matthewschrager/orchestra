import { Hono } from "hono";
import { extname } from "path";
import { homedir } from "os";

/** Image extensions safe for inline rendering (SVG excluded — XSS risk via script tags) */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

/** Safe document types to serve inline as plain text or PDF */
const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".pdf",
]);

const ALLOWED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS]);

function resolveRequestedPath(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return `${homedir()}/${rawPath.slice(2)}`;
  return rawPath;
}

function contentTypeFor(filePath: string, detectedType: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  return detectedType || "application/octet-stream";
}

export function createFileRoutes() {
  const app = new Hono();

  app.get("/serve", async (c) => {
    const requestedPath = c.req.query("path");

    // Must provide a path
    if (!requestedPath) {
      return c.json({ error: "Missing 'path' query parameter" }, 400);
    }

    const filePath = resolveRequestedPath(requestedPath);

    // Must be absolute after optional ~/ expansion
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

    const contentType = contentTypeFor(filePath, file.type);

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
