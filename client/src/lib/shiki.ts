// Shared Shiki highlighter singleton — lazy-loaded, used by ReadRenderer + DiffRenderer
import type { HighlighterCore } from "shiki";

let shikiPromise: Promise<HighlighterCore | null> | null = null;

export function getHighlighter(): Promise<HighlighterCore | null> {
  if (!shikiPromise) {
    shikiPromise = import("shiki")
      .then(({ createHighlighter }) =>
        createHighlighter({ themes: ["github-dark-default"], langs: [] }),
      )
      .catch(() => null);
  }
  return shikiPromise;
}

/** Map file extension → Shiki language identifier */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rb: "ruby", rs: "rust", go: "go",
    java: "java", kt: "kotlin", swift: "swift",
    css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", sql: "sql", sh: "bash", zsh: "bash", bash: "bash",
    dockerfile: "dockerfile", graphql: "graphql",
  };
  return langMap[ext] || "text";
}
