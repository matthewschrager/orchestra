import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolImageArtifact {
  src: string;
  mimeType?: string;
  alt?: string;
}

export interface NormalizedToolResultContent {
  text: string;
  images: ToolImageArtifact[];
}

const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const PERSISTED_TOOL_IMAGE_DIR = "/tmp/orchestra-tool-result-images";

export function normalizeToolResultContent(content: unknown): NormalizedToolResultContent {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }

  if (!Array.isArray(content) && !isRecord(content)) {
    return { text: "", images: [] };
  }

  const textParts = extractTextParts(content);
  const images = extractToolResultImages(content);

  return {
    text: textParts.join("\n").trim(),
    images,
  };
}

export function extractToolResultImages(content: unknown): ToolImageArtifact[] {
  const images: ToolImageArtifact[] = [];
  const seen = new Set<string>();
  collectToolResultImages(content, images, seen, 0);
  return images;
}

function extractImageBlock(
  block: Record<string, unknown>,
  index: number,
): ToolImageArtifact | null {
  const directImage = buildImageArtifact(block, index);
  if (directImage) return directImage;

  const source = isRecord(block.source) ? block.source : null;
  if (!source) return null;
  return buildImageArtifact(source, index);
}

function buildImageArtifact(
  value: Record<string, unknown>,
  index: number,
): ToolImageArtifact | null {
  const pathImage = buildPathImageArtifact(value, index);
  if (pathImage) return pathImage;

  const mimeType = extractMimeType(value);
  const alt = extractAltText(value, index);
  const data = typeof value.data === "string" ? value.data : null;
  if (data && isSafeRenderableImageMimeType(mimeType)) {
    const persistedSrc = persistBase64ImageToFile(data, mimeType);
    return {
      src: persistedSrc ?? `data:${mimeType};base64,${data}`,
      mimeType,
      alt,
    };
  }

  const uri = typeof value.uri === "string"
    ? value.uri
    : typeof value.url === "string"
      ? value.url
      : null;
  if (uri && isRenderableImageUri(uri, mimeType)) {
    return {
      src: uri,
      mimeType: mimeType ?? undefined,
      alt,
    };
  }

  return null;
}

function buildPathImageArtifact(
  value: Record<string, unknown>,
  index: number,
): ToolImageArtifact | null {
  const path = extractImagePath(value);
  if (!path || !isRenderableImagePath(path)) return null;

  return {
    src: buildFileServeUrl(path),
    mimeType: extractMimeType(value) ?? inferImageMimeTypeFromPath(path) ?? undefined,
    alt: extractAltText(value, index),
  };
}

function extractMimeType(value: Record<string, unknown>): string | null {
  if (typeof value.mimeType === "string") return value.mimeType;
  if (typeof value.mediaType === "string") return value.mediaType;
  if (typeof value.mime_type === "string") return value.mime_type;
  return null;
}

function extractAltText(value: Record<string, unknown>, index: number): string {
  if (typeof value.alt === "string" && value.alt.trim()) return value.alt;
  if (typeof value.label === "string" && value.label.trim()) return value.label;
  if (typeof value.title === "string" && value.title.trim()) return value.title;
  return `Tool image ${index}`;
}

function isRenderableImageUri(uri: string, mimeType: string | null): boolean {
  const dataMime = uri.startsWith("data:") ? extractDataUrlMimeType(uri) : null;
  if (dataMime) return isSafeRenderableImageMimeType(dataMime);
  if (isSafeRenderableImageMimeType(mimeType)) return true;
  return /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.test(uri);
}

function isRenderableImagePath(path: string): boolean {
  return /^(?:\/|~\/)/.test(path) && /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRenderableImageMimeType(mimeType: string | null): mimeType is string {
  return mimeType !== null && SAFE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

function extractDataUrlMimeType(uri: string): string | null {
  const match = uri.match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : null;
}

function extractTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts;
}

function collectToolResultImages(
  value: unknown,
  images: ToolImageArtifact[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 6 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolResultImages(item, images, seen, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) return;

  const image = extractImageBlock(value, images.length + 1);
  if (image && !seen.has(image.src)) {
    seen.add(image.src);
    images.push(image);
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child) || isRecord(child)) {
      collectToolResultImages(child, images, seen, depth + 1);
    }
  }
}

function extractImagePath(value: Record<string, unknown>): string | null {
  const path = value.path
    ?? value.file_path
    ?? value.filePath
    ?? value.local_path
    ?? value.localPath;
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

function inferImageMimeTypeFromPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return null;
}

function extensionForMimeType(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/bmp") return ".bmp";
  return null;
}

function persistBase64ImageToFile(data: string, mimeType: string): string | null {
  const ext = extensionForMimeType(mimeType);
  if (!ext) return null;

  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return null;

    mkdirSync(PERSISTED_TOOL_IMAGE_DIR, { recursive: true });

    const hash = createHash("sha256")
      .update(mimeType)
      .update(":")
      .update(data)
      .digest("hex")
      .slice(0, 32);
    const filePath = join(PERSISTED_TOOL_IMAGE_DIR, `${hash}${ext}`);

    if (!existsSync(filePath)) {
      writeFileSync(filePath, bytes);
    }

    return buildFileServeUrl(filePath);
  } catch {
    return null;
  }
}

function buildFileServeUrl(path: string): string {
  return `/api/files/serve?path=${encodeURIComponent(path)}`;
}
