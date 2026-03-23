import { useState, useCallback, useEffect } from "react";
import type { AttentionItem, AttentionResolution, WSServerMessage } from "shared";
import { api } from "./useApi";

/**
 * Manages attention items (pending agent questions/permissions) across all threads.
 * Listens for WS events and provides resolution actions.
 */
export function useAttention() {
  const [items, setItems] = useState<Map<string, AttentionItem>>(new Map());

  // Load initial pending items from REST API
  useEffect(() => {
    api.listAttention().then((data) => {
      setItems(new Map(data.map((a) => [a.id, a])));
    }).catch(() => {});
  }, []);

  const handleWSMessage = useCallback((msg: WSServerMessage) => {
    if (msg.type === "attention_required") {
      setItems((prev) => {
        const next = new Map(prev);
        next.set(msg.attention.id, msg.attention);
        return next;
      });
    } else if (msg.type === "attention_resolved") {
      setItems((prev) => {
        const next = new Map(prev);
        next.delete(msg.attentionId);
        return next;
      });
    }
  }, []);

  const pendingItems = Array.from(items.values())
    .filter((a) => !a.resolvedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const pendingCount = pendingItems.length;

  const pendingByThread = pendingItems.reduce<Map<string, AttentionItem[]>>((acc, item) => {
    const list = acc.get(item.threadId) ?? [];
    list.push(item);
    acc.set(item.threadId, list);
    return acc;
  }, new Map());

  return {
    items: pendingItems,
    pendingCount,
    pendingByThread,
    handleWSMessage,
  };
}
