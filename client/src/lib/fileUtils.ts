/** Image extensions safe for inline rendering (SVG excluded — XSS risk) */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

/** Safe document extensions that can be served inline as text or PDF */
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

const RESERVED_WEB_PATH_PREFIXES = [
  "/api/",
  "/assets/",
  "/static/",
  "/ws",
];

const RESERVED_WEB_PATHS = new Set([
  "/",
  "/favicon.svg",
  "/manifest.json",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
]);

const COMMON_FILESYSTEM_ROOTS = [
  "/home/",
  "/Users/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/workspace/",
  "/workspaces/",
];

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const HASH_LINE_REF = /^#L(\d+)(?:C(\d+))?$/i;

export interface LocalFileHref {
  path: string;
  line?: number;
  col?: number;
}

function getExtension(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= lastSlash) return "";
  return path.slice(lastDot).toLowerCase();
}

function hasRecognizedExtension(path: string): boolean {
  const ext = getExtension(path);
  return IMAGE_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
}

function stripQueryAndHash(value: string): string {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  let end = value.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (hashIndex !== -1) end = Math.min(end, hashIndex);
  return value.slice(0, end);
}

function looksLikeFilesystemPath(path: string): boolean {
  const barePath = stripQueryAndHash(path);
  if (!barePath.startsWith("/") || barePath.startsWith("//")) return false;
  if (RESERVED_WEB_PATHS.has(barePath)) return false;
  if (RESERVED_WEB_PATH_PREFIXES.some((prefix) => barePath.startsWith(prefix))) return false;
  if (COMMON_FILESYSTEM_ROOTS.some((prefix) => barePath.startsWith(prefix))) return true;
  return hasRecognizedExtension(barePath) && barePath.indexOf("/", 1) !== -1;
}

function splitLineAndCol(path: string, hash?: string): LocalFileHref {
  let line: number | undefined;
  let col: number | undefined;

  if (hash) {
    const hashMatch = hash.match(HASH_LINE_REF);
    if (hashMatch) {
      line = Number(hashMatch[1]);
      col = hashMatch[2] ? Number(hashMatch[2]) : undefined;
    }
  }

  const suffixMatch = path.match(/^(.*?)(?::(\d+)(?::(\d+))?)$/);
  if (suffixMatch && hasRecognizedExtension(suffixMatch[1])) {
    return {
      path: suffixMatch[1],
      line: Number(suffixMatch[2]),
      col: suffixMatch[3] ? Number(suffixMatch[3]) : undefined,
    };
  }

  return { path, line, col };
}

/** Check if a file path points to a renderable image */
export function isImageFile(path: string): boolean {
  if (!path) return false;
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

/** Check if a file path can be safely served inline */
export function isServableFilePath(path: string): boolean {
  if (!path) return false;
  const ext = getExtension(path);
  return IMAGE_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
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

/** Whether the browser is running on a host where vscode:// deep-links can work */
export function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Build a vscode:// URI for opening a file at an optional line/col */
export function buildVscodeUrl(path: string, line?: number, col?: number): string {
  let url = `vscode://file${path}`;
  if (line != null) {
    url += `:${line}`;
    if (col != null) url += `:${col}`;
  }
  return url;
}

/** Parse markdown hrefs that actually point to local filesystem paths */
export function parseLocalFileHref(href: string | null | undefined): LocalFileHref | null {
  if (!href) return null;

  const trimmed = href.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      let path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      return splitLineAndCol(path, url.hash || undefined);
    } catch {
      return null;
    }
  }

  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return splitLineAndCol(stripQueryAndHash(trimmed));
  }

  if (WINDOWS_DRIVE_PATH.test(trimmed)) {
    return splitLineAndCol(stripQueryAndHash(trimmed));
  }

  if (looksLikeFilesystemPath(trimmed)) {
    const barePath = stripQueryAndHash(trimmed);
    const hash = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#")) : undefined;
    return splitLineAndCol(barePath, hash);
  }

  return null;
}
