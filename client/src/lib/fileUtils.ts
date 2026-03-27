/** Image extensions safe for inline rendering (SVG excluded — XSS risk) */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

/** Check if a file path points to a renderable image */
export function isImageFile(path: string): boolean {
  if (!path) return false;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Shorten a path for display — shows last 3 segments with …/ prefix */
export function shortenPath(p: string): string {
  if (!p || !p.includes("/")) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-3).join("/");
}

/** Build the URL to the file proxy endpoint */
export function fileServeUrl(absolutePath: string): string {
  return `/api/files/serve?path=${encodeURIComponent(absolutePath)}`;
}
