import { Hono } from "hono";
import { join, extname } from "path";
import { mkdirSync, readdirSync } from "fs";
import { nanoid } from "nanoid";
import type { Attachment } from "shared";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const NANOID_RE = /^[a-zA-Z0-9_-]{8,24}$/;

export function createUploadRoutes(uploadsDir: string) {
  const app = new Hono();

  // Ensure uploads directory exists
  mkdirSync(uploadsDir, { recursive: true });

  // Upload a file
  app.post("/", async (c) => {
    const contentType = c.req.header("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, 400);
    }

    const mimeType = file.type || "application/octet-stream";
    const id = nanoid(12);
    const ext = extname(file.name) || mimeGuessExt(mimeType);
    const storedName = `${id}${ext}`;
    const filePath = join(uploadsDir, storedName);

    // Write file to disk
    const buffer = await file.arrayBuffer();
    await Bun.write(filePath, buffer);

    const attachment: Attachment = {
      id,
      filename: file.name,
      mimeType,
      size: file.size,
      url: `/api/uploads/${id}`,
    };

    return c.json(attachment, 201);
  });

  // Serve an uploaded file
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    if (!NANOID_RE.test(id)) return c.json({ error: "Invalid ID" }, 400);
    const match = findUploadById(uploadsDir, id);

    if (!match) {
      return c.json({ error: "File not found" }, 404);
    }

    const filePath = join(uploadsDir, match);
    const file = Bun.file(filePath);
    const contentType = file.type || "application/octet-stream";
    // Only allow images to render inline — everything else forces download
    // to prevent stored XSS via uploaded HTML/SVG
    const isImage = contentType.startsWith("image/") && contentType !== "image/svg+xml";
    return new Response(file.stream(), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...(isImage ? {} : { "Content-Disposition": `attachment; filename="${match}"` }),
      },
    });
  });

  return app;
}

/** Resolve attachment IDs to absolute file paths */
export function resolveAttachmentPaths(
  attachments: Attachment[],
  uploadsDir: string,
): Array<{ attachment: Attachment; absolutePath: string }> {
  let files: string[];
  try {
    files = readdirSync(uploadsDir);
  } catch {
    return [];
  }

  return attachments
    .map((attachment) => {
      const match = files.find((f) => f === attachment.id || f.startsWith(attachment.id + "."));
      if (!match) return null;
      return { attachment, absolutePath: join(uploadsDir, match) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

function findUploadById(uploadsDir: string, id: string): string | undefined {
  try {
    const files = readdirSync(uploadsDir);
    // Match "id.ext" or "id" exactly — not just prefix
    return files.find((f) => f === id || f.startsWith(id + "."));
  } catch {
    return undefined;
  }
}

function mimeGuessExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/markdown": ".md",
    "application/json": ".json",
  };
  return map[mime] || "";
}
