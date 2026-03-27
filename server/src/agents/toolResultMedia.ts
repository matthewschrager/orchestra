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

export function normalizeToolResultContent(content: unknown): NormalizedToolResultContent {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }

  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }

  const textParts: string[] = [];
  const images: ToolImageArtifact[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }

    const image = extractImageBlock(block, images.length + 1);
    if (image) images.push(image);
  }

  return {
    text: textParts.join("\n").trim(),
    images,
  };
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
  const mimeType = extractMimeType(value);
  const alt = extractAltText(value, index);
  const data = typeof value.data === "string" ? value.data : null;
  if (data && isSafeRenderableImageMimeType(mimeType)) {
    return {
      src: `data:${mimeType};base64,${data}`,
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
