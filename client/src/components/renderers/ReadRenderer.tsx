import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { getHighlighter, detectLanguage } from "../../lib/shiki";
import { isImageFile, shortenPath, fileServeUrl } from "../../lib/fileUtils";
import { FilePathLink } from "../FilePathLink";
import { ImageLightbox } from "../ImageLightbox";

interface ParsedRead {
  filePath: string;
  content: string;
  lineStart: number;
  language: string;
  /** True when the file is an image that can be rendered inline */
  isImage: boolean;
}

export function parseRead(input: string | null, output: string | null): ParsedRead | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    const filePath: string = parsed.file_path || parsed.filePath || "";
    if (!filePath) return null;

    const content = output || "";
    // Detect line offset from input params
    const lineStart: number = parsed.offset || 1;

    // Check image extension BEFORE content-based binary check
    if (isImageFile(filePath)) {
      return { filePath, content: "", lineStart, language: "", isImage: true };
    }

    const language = detectLanguage(filePath);

    // Check for binary content
    if (isBinary(content)) {
      return { filePath, content: "", lineStart, language: "", isImage: false };
    }

    return { filePath, content, lineStart, language, isImage: false };
  } catch {
    return null;
  }
}

function isBinary(content: string): boolean {
  // Check for null bytes or high ratio of non-printable characters
  const sample = content.slice(0, 512);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
  }
  return sample.length > 0 && nonPrintable / sample.length > 0.1;
}

interface Props {
  input: string | null;
  output: string | null;
}

export function ReadRenderer({ input, output }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const shikiRef = useRef<boolean>(false);
  const read = parseRead(input, output);

  if (!read) return null;

  // Image file — render inline preview with lightbox
  if (read.isImage && read.filePath) {
    const imgSrc = fileServeUrl(read.filePath);
    return (
      <div className="renderer-block">
        <div className="renderer-header">
          <FilePathLink path={read.filePath} />
        </div>
        <div className="renderer-body p-2">
          {imgError ? (
            <div className="text-xs text-content-3 italic">Binary file</div>
          ) : (
            <img
              src={imgSrc}
              alt={shortenPath(read.filePath)}
              className="max-h-[300px] max-w-full rounded cursor-pointer hover:opacity-90 transition-opacity max-sm:max-h-[200px]"
              onClick={() => setLightboxOpen(true)}
              onError={() => setImgError(true)}
              loading="lazy"
            />
          )}
        </div>
        {lightboxOpen && (
          <ImageLightbox
            src={imgSrc}
            alt={shortenPath(read.filePath)}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </div>
    );
  }

  // Non-image binary file
  if (!read.content && read.filePath) {
    return (
      <div className="renderer-block">
        <div className="renderer-header">
          <FilePathLink path={read.filePath} />
        </div>
        <div className="renderer-body text-xs text-content-3 italic">Binary file</div>
      </div>
    );
  }

  // Empty file
  if (!read.content.trim()) {
    return (
      <div className="renderer-block">
        <div className="renderer-header">
          <FilePathLink path={read.filePath} />
        </div>
        <div className="renderer-body text-xs text-content-3 italic">Empty file</div>
      </div>
    );
  }

  const lines = read.content.split("\n");
  // Strip cat -n line number prefix if present (format: "   1\tcode")
  const strippedLines = lines.map((line) => {
    const match = line.match(/^\s*\d+\t(.*)$/);
    return match ? match[1] : line;
  });

  const needsTruncation = strippedLines.length > 20 && !expanded;
  const displayLines = needsTruncation ? strippedLines.slice(0, 20) : strippedLines;

  // Lazy-load Shiki for syntax highlighting (uses module-level singleton)
  useEffect(() => {
    if (shikiRef.current || !read.language || read.language === "text") return;
    shikiRef.current = true;

    getHighlighter().then(async (highlighter) => {
      if (!highlighter) return;
      try {
        await highlighter.loadLanguage(read.language);
        const html = highlighter.codeToHtml(displayLines.join("\n"), {
          lang: read.language,
          theme: "github-dark-default",
        });
        setHighlighted(DOMPurify.sanitize(html));
      } catch {
        // Language not supported or Shiki failed — fall through to plain text
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps — shikiRef guard prevents re-execution
  }, [read.language]);

  return (
    <div className="renderer-block">
      <div className="renderer-header">
        <FilePathLink path={read.filePath} />
        <span className="text-[11px] text-content-3 shrink-0">
          {read.language !== "text" && <span className="mr-2">{read.language}</span>}
          lines {read.lineStart}–{read.lineStart + displayLines.length - 1}
        </span>
      </div>
      {highlighted ? (
        <div
          className="renderer-body shiki-output text-xs overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="renderer-body text-xs overflow-x-auto">
          {displayLines.map((line, i) => (
            <div key={i} className="flex">
              <span className="read-line-num">{read.lineStart + i}</span>
              <span className="flex-1">{line}</span>
            </div>
          ))}
        </pre>
      )}
      {needsTruncation && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-center text-[11px] text-content-3 hover:text-content-2 py-1.5 border-t border-edge-1"
        >
          Show all {strippedLines.length} lines
        </button>
      )}
    </div>
  );
}

