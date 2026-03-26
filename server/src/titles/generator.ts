import { query } from "@anthropic-ai/claude-agent-sdk";

const TITLE_SYSTEM =
  "Generate a concise 3-6 word title for a coding task. Reply with ONLY the title text — no quotes, no punctuation at the end, no explanation.";

/** Timeout for title generation subprocess (30 seconds) */
const TITLE_TIMEOUT_MS = 30_000;

/**
 * Generate a short AI title from a user prompt using the existing Agent SDK.
 * Returns the title string, or null on failure/timeout.
 */
export async function generateTitle(prompt: string): Promise<string | null> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);

  try {
    const q = query({
      prompt: `${TITLE_SYSTEM}\n\nTask: ${prompt.slice(0, 500)}`,
      options: {
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        cwd: "/tmp",
        abortController,
      },
    });

    let title = "";

    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      if (m.type === "assistant") {
        const message = m.message as {
          content?: Array<{ type: string; text?: string }>;
        } | null;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && block.text) {
            title += block.text;
          }
        }
      }
    }

    title = title.trim().replace(/^["']|["']$/g, "").trim();
    if (!title) return null;
    return title.slice(0, 80);
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.warn("[title-gen] Failed to generate title:", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
