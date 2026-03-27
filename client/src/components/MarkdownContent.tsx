import { memo, useCallback, useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import DOMPurify from "dompurify";
import type { Components } from "react-markdown";
import type { Highlighter } from "shiki";
import { wrapAsciiArt } from "../lib/asciiArt";
import {
  buildVscodeUrl,
  fileServeUrl,
  isLocalhostHostname,
  isServableFilePath,
  parseLocalFileHref,
} from "../lib/fileUtils";

let highlighterPromise: Promise<Highlighter> | null = null;
let cachedHighlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (cachedHighlighter) return cachedHighlighter;
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((mod) =>
      mod.createHighlighter({
        themes: ["vitesse-dark"],
        langs: [
          "javascript", "typescript", "python", "bash", "json", "html",
          "css", "rust", "go", "ruby", "sql", "yaml", "markdown", "tsx",
          "jsx", "diff", "shell",
        ],
      }),
    );
  }
  cachedHighlighter = await highlighterPromise;
  return cachedHighlighter;
}

// Pre-warm highlighter
getHighlighter();

function isLocalhost(): boolean {
  if (typeof window === "undefined") return false;
  return isLocalhostHostname(window.location.hostname);
}

function CodeBlock({ className, children }: { className?: string; children: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lang = className?.replace("language-", "") ?? "";

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const result = hl.codeToHtml(children.replace(/\n$/, ""), {
          lang: hl.getLoadedLanguages().includes(lang) ? lang : "text",
          theme: "vitesse-dark",
        });
        setHtml(DOMPurify.sanitize(result));
      } catch {
        // Fallback — lang not supported
      }
    });
    return () => { cancelled = true; };
  }, [children, lang]);

  if (html) {
    return (
      <div
        className="md-code-block"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="md-code-block">
      <code>{children}</code>
    </pre>
  );
}

function MarkdownLink({ href, children, ...props }: ComponentProps<"a">) {
  const [copied, setCopied] = useState(false);
  const localFile = parseLocalFileHref(href);

  const handleCopy = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may fail in insecure contexts
    }
  }, []);

  if (!localFile) {
    return <a href={href} {...props}>{children}</a>;
  }

  if (isServableFilePath(localFile.path)) {
    return (
      <a
        href={fileServeUrl(localFile.path)}
        target="_blank"
        rel="noreferrer"
        title={localFile.path}
        {...props}
      >
        {children}
      </a>
    );
  }

  if (isLocalhost()) {
    return (
      <a
        href={buildVscodeUrl(localFile.path, localFile.line, localFile.col)}
        title={localFile.path}
        {...props}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy(localFile.path)}
      title={copied ? "Copied path" : `Copy path: ${localFile.path}`}
      className="text-accent hover:text-accent-light underline underline-offset-2"
    >
      {children}
    </button>
  );
}

const components: Components = {
  code({ className, children, ...props }) {
    const isBlock = className?.startsWith("language-");
    const text = String(children);
    if (isBlock) {
      return <CodeBlock className={className} children={text} />;
    }
    return <code className="md-inline-code" {...props}>{children}</code>;
  },
  pre({ children }) {
    // Unwrap — CodeBlock handles its own <pre>
    return <>{children}</>;
  },
  a({ href, children, ...props }) {
    return <MarkdownLink href={href} {...props}>{children}</MarkdownLink>;
  },
};

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const processed = wrapAsciiArt(content);
  return (
    <div className="md-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
});
