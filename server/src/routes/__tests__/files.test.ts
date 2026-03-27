import { describe, expect, test } from "bun:test";
import { createFileRoutes } from "../files";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

function createApp() {
  const app = new Hono();
  app.route("/files", createFileRoutes());
  return app;
}

describe("GET /files/serve", () => {
  test("returns 400 when path is missing", async () => {
    const app = createApp();
    const res = await app.request("/files/serve");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing");
  });

  test("returns 400 for relative path", async () => {
    const app = createApp();
    const res = await app.request("/files/serve?path=relative/path.png");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("absolute");
  });

  test("returns 400 for path traversal", async () => {
    const app = createApp();
    const res = await app.request("/files/serve?path=/tmp/../etc/passwd");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("traversal");
  });

  test("returns 403 for non-image extension", async () => {
    const app = createApp();
    const res = await app.request("/files/serve?path=/tmp/test.ts");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not allowed");
  });

  test("returns 403 for SVG (XSS risk)", async () => {
    const app = createApp();
    const res = await app.request("/files/serve?path=/tmp/test.svg");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not allowed");
  });

  test("returns 404 for nonexistent image file", async () => {
    const app = createApp();
    const res = await app.request("/files/serve?path=/tmp/nonexistent-image-12345.png");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  test("serves a valid PNG file", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-files-test-"));
    const imgPath = resolve(tmp, "test.png");
    // 1x1 red pixel PNG
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(imgPath, pngBytes);

    const app = createApp();
    const res = await app.request(`/files/serve?path=${encodeURIComponent(imgPath)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(pngBytes.length);

    rmSync(tmp, { recursive: true });
  });

  test("serves JPEG files", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-files-test-"));
    const imgPath = resolve(tmp, "photo.jpg");
    writeFileSync(imgPath, Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic bytes

    const app = createApp();
    const res = await app.request(`/files/serve?path=${encodeURIComponent(imgPath)}`);
    expect(res.status).toBe(200);

    rmSync(tmp, { recursive: true });
  });

  test("serves WebP files", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-files-test-"));
    const imgPath = resolve(tmp, "image.webp");
    writeFileSync(imgPath, Buffer.from("RIFF....WEBP", "ascii"));

    const app = createApp();
    const res = await app.request(`/files/serve?path=${encodeURIComponent(imgPath)}`);
    expect(res.status).toBe(200);

    rmSync(tmp, { recursive: true });
  });

  test("handles URL-encoded paths", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-files-test-"));
    const imgPath = resolve(tmp, "my screenshot.png");
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

    const app = createApp();
    const res = await app.request(`/files/serve?path=${encodeURIComponent(imgPath)}`);
    expect(res.status).toBe(200);

    rmSync(tmp, { recursive: true });
  });
});
