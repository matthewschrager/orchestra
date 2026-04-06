import { describe, expect, test } from "bun:test";
import { getContentUpdateScrollState, getUserMessageQueueDisplayState } from "../ChatView";

describe("chat view scroll state", () => {
  test("clears the unread baseline when the user is at the bottom", () => {
    expect(getContentUpdateScrollState({
      atBottom: true,
      currentBaseline: 4,
      previousMessageCount: 7,
    })).toEqual({
      atBottom: true,
      nextBaseline: 0,
    });
  });

  test("uses the previous message count when new content arrives off-screen", () => {
    expect(getContentUpdateScrollState({
      atBottom: false,
      currentBaseline: 0,
      previousMessageCount: 7,
    })).toEqual({
      atBottom: false,
      nextBaseline: 7,
    });
  });

  test("preserves the existing unread baseline while the user stays scrolled away", () => {
    expect(getContentUpdateScrollState({
      atBottom: false,
      currentBaseline: 7,
      previousMessageCount: 8,
    })).toEqual({
      atBottom: false,
      nextBaseline: 7,
    });
  });
});

describe("user message queue display state", () => {
  test("prefers server sent state over the client queued fallback", () => {
    expect(getUserMessageQueueDisplayState({
      hasQueueMessageId: true,
      isQueued: true,
      queueState: "sent",
    })).toEqual({
      showQueueBadge: true,
      isSent: true,
    });
  });

  test("suppresses the local queued fallback once a server queue id exists", () => {
    expect(getUserMessageQueueDisplayState({
      hasQueueMessageId: true,
      isQueued: true,
      queueState: undefined,
    })).toEqual({
      showQueueBadge: false,
      isSent: false,
    });
  });

  test("uses the local fallback only for legacy messages without a queue id", () => {
    expect(getUserMessageQueueDisplayState({
      hasQueueMessageId: false,
      isQueued: true,
      queueState: undefined,
    })).toEqual({
      showQueueBadge: true,
      isSent: false,
    });
  });
});
