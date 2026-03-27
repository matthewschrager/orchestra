import type { Message } from "shared";

export const ATTACHMENT_ONLY_PLACEHOLDER = "(see attached files)";

export type HistoryDirection = "older" | "newer";

export function buildInputHistory(messages: Message[]): string[] {
  const history: string[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (message.content.trim().length === 0) continue;

    const attachments = message.metadata?.attachments;
    const isAttachmentOnlyPlaceholder =
      message.content === ATTACHMENT_ONLY_PLACEHOLDER &&
      Array.isArray(attachments) &&
      attachments.length > 0;

    if (isAttachmentOnlyPlaceholder) continue;
    history.push(message.content);
  }

  return history;
}

export function canNavigateInputHistory(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  historyIndex: number | null,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  if (selectionEnd !== value.length) return false;
  return historyIndex !== null || value.trim() === "";
}

export function getNextInputHistoryState(
  history: string[],
  historyIndex: number | null,
  direction: HistoryDirection,
): { index: number | null; value: string } | null {
  if (history.length === 0) return null;

  if (direction === "older") {
    const nextIndex = historyIndex === null ? 0 : Math.min(historyIndex + 1, history.length - 1);
    return { index: nextIndex, value: history[nextIndex] };
  }

  if (historyIndex === null) return null;
  if (historyIndex === 0) return { index: null, value: "" };

  const nextIndex = historyIndex - 1;
  return { index: nextIndex, value: history[nextIndex] };
}
