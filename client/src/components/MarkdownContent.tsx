import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import DOMPurify from "dompurify";
import type { Components } from "react-markdown";
import type { Highlighter } from "shiki";

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
};

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="md-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
