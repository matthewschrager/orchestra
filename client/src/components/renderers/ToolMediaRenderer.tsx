import { useState } from "react";
import { ImageLightbox } from "../ImageLightbox";
import { fileServeUrl, isImageFile, parseLocalFileHref } from "../../lib/fileUtils";

export interface ToolImageArtifact {
  src: string;
  mimeType?: string;
  alt?: string;
}

const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

export function getToolImages(metadata: Record<string, unknown> | null | undefined): ToolImageArtifact[] {
  if (!metadata) return [];
  const rawImages = metadata.images;
  if (!Array.isArray(rawImages)) return [];

  return rawImages.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.src !== "string" || !item.src) return [];
    const src = normalizeToolImageSrc(item.src);
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    if (!isSafeRenderableToolImage(src, mimeType)) return [];
    return [{
      src,
      mimeType,
      alt: typeof item.alt === "string" && item.alt.trim() ? item.alt : `Tool image ${index + 1}`,
    }];
  });
}

export function hasToolImages(metadata: Record<string, unknown> | null | undefined): boolean {
  return getToolImages(metadata).length > 0;
}

export function ToolMediaRenderer({
  output,
  metadata,
}: {
  output: string | null;
  metadata: Record<string, unknown> | null | undefined;
}) {
  const images = getToolImages(metadata);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (images.length === 0) return null;

  return (
    <div className="renderer-block">
      {output?.trim() ? (
        <div className="renderer-body text-xs whitespace-pre-wrap break-words border-b border-edge-1">
          {output}
        </div>
      ) : null}
      <div className="renderer-body p-2">
        <div className="flex gap-2 flex-wrap">
          {images.map((image, index) => (
            <img
              key={`${image.src}-${index}`}
              src={image.src}
              alt={image.alt ?? `Tool image ${index + 1}`}
              loading="lazy"
              className="max-h-64 max-w-full rounded cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxIndex(index)}
            />
          ))}
        </div>
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          src={images[lightboxIndex].src}
          alt={images[lightboxIndex].alt ?? `Tool image ${lightboxIndex + 1}`}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRenderableToolImage(src: string, mimeType?: string): boolean {
  const normalizedMime = mimeType?.toLowerCase();
  if (src.startsWith("data:")) {
    const dataMime = extractDataUrlMimeType(src);
    return dataMime ? SAFE_IMAGE_MIME_TYPES.has(dataMime) : false;
  }
  if (normalizedMime && SAFE_IMAGE_MIME_TYPES.has(normalizedMime)) return true;
  return /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.test(src);
}

function extractDataUrlMimeType(src: string): string | null {
  const match = src.match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizeToolImageSrc(src: string): string {
  if (src.startsWith("data:") || src.startsWith("blob:") || src.startsWith("http://") ||
      src.startsWith("https://") || src.startsWith("/api/files/serve?")) {
    return src;
  }

  const localFile = parseLocalFileHref(src);
  if (localFile && isImageFile(localFile.path)) {
    return fileServeUrl(localFile.path);
  }

  return src;
}
