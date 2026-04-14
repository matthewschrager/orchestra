import { describe, expect, test } from "bun:test";
import {
  buildThreadStartParams,
  buildTurnStartParams,
  createCodexNormalizerState,
  normalizeCodexServerRequest,
  normalizeCodexServerMessage,
  toCodexTransportConfig,
} from "../codex-app-server/protocol";

describe("Codex app-server protocol helpers", () => {
  test("maps Orchestra default Codex permissions onto app-server semantics", () => {
    expect(toCodexTransportConfig("bypassPermissions")).toEqual({
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });

    expect(toCodexTransportConfig("acceptEdits")).toEqual({
      approvalPolicy: "on-failure",
      sandboxMode: "workspace-write",
    });

    expect(toCodexTransportConfig("default")).toEqual({
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
  });

  test("builds thread and turn params with workspace-write sandbox overrides", () => {
    const threadParams = buildThreadStartParams({
      cwd: "/repo",
      model: "gpt-5-codex",
      permissionMode: "default",
    });
    const turnParams = buildTurnStartParams("thread-1", "Fix it", {
      cwd: "/repo",
      model: "gpt-5-codex",
      permissionMode: "default",
      effortLevel: "medium",
    });

    expect(threadParams).toMatchObject({
      cwd: "/repo",
      model: "gpt-5-codex",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(turnParams).toMatchObject({
      threadId: "thread-1",
      cwd: "/repo",
      model: "gpt-5-codex",
      approvalPolicy: "on-request",
      effort: "medium",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: false,
      },
    });
  });

  test("normalizes plan updates into todo_list items", () => {
    const state = createCodexNormalizerState();
    const events = normalizeCodexServerMessage({
      method: "turn/plan/updated",
      params: {
        turnId: "turn-1",
        plan: [
          { step: "Inspect transport", status: "completed" },
          { step: "Wire metrics", status: "inProgress" },
          { step: "Run tests", status: "pending" },
        ],
      },
    }, state);

    expect(events).toEqual([{
      type: "item.updated",
      item: {
        id: "turn-plan:turn-1",
        type: "todo_list",
        items: [
          { text: "Inspect transport", completed: true, status: "completed" },
          { text: "Wire metrics", completed: false, status: "in_progress" },
          { text: "Run tests", completed: false, status: "pending" },
        ],
      },
    }]);
  });

  test("normalizes token usage notifications with separate cached and reasoning fields", () => {
    const state = createCodexNormalizerState();
    const events = normalizeCodexServerMessage({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: {
            inputTokens: 1000,
            cachedInputTokens: 250,
            outputTokens: 200,
            reasoningOutputTokens: 50,
          },
          modelContextWindow: 200_000,
        },
      },
    }, state);

    expect(events).toEqual([{
      type: "thread.token_usage.updated",
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 250,
        output_tokens: 200,
        reasoning_output_tokens: 50,
      },
      context_window: 200_000,
    }]);
  });

  test("normalizes approval requests into permission attention items", () => {
    const event = normalizeCodexServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "bun test",
        cwd: "/repo",
        reason: "Needs to run tests",
      },
    });

    expect(event).toEqual({
      type: "attention.request",
      attention: {
        kind: "permission",
        prompt: "Codex wants to run:\nbun test\nCWD: /repo\nReason: Needs to run tests",
        metadata: {
          source: "codex_app_server_request",
          codexRequestId: 7,
          codexRequestMethod: "item/commandExecution/requestApproval",
          codexRequestParams: {
            command: "bun test",
            cwd: "/repo",
            reason: "Needs to run tests",
          },
        },
      },
    });
  });

  test("normalizes request_user_input into ask_user attention items", () => {
    const event = normalizeCodexServerRequest({
      id: "q-1",
      method: "item/tool/requestUserInput",
      params: {
        questions: [{
          id: "branch",
          header: "Branch",
          question: "Which branch should I use?",
          options: [
            { label: "main", description: "Stable" },
            { label: "staging", description: "Integration" },
          ],
        }],
      },
    });

    expect(event).toEqual({
      type: "attention.request",
      attention: {
        kind: "ask_user",
        prompt: "Branch: Which branch should I use?",
        options: ["main", "staging"],
        metadata: {
          source: "codex_app_server_request",
          codexRequestId: "q-1",
          codexRequestMethod: "item/tool/requestUserInput",
          codexRequestParams: {
            questions: [{
              id: "branch",
              header: "Branch",
              question: "Which branch should I use?",
              options: [
                { label: "main", description: "Stable" },
                { label: "staging", description: "Integration" },
              ],
            }],
          },
        },
      },
    });
  });
});
