import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createCanUseTool } from "../claude";

/**
 * Regression tests for the canUseTool permission callback.
 *
 * The Claude CLI's runtime Zod schema for permission responses is stricter
 * than the SDK TypeScript types suggest:
 *
 *   Allow branch:  { behavior: "allow", updatedInput: Record<string, unknown>, ... }
 *   Deny branch:   { behavior: "deny", message: string, interrupt?: boolean, ... }
 *
 * Specifically, `updatedInput` is REQUIRED by the CLI Zod schema even though
 * the SDK's TS types mark it as optional. Omitting it causes a ZodError that
 * the CLI catches and converts into a blanket deny — breaking all tool usage.
 *
 * These tests enforce the stricter runtime contract.
 */

// ── CLI Zod schema (extracted from cli.js, SDK v0.2.81) ─────
// This is the exact schema the CLI uses to parse permission responses.
// If the SDK changes its schema, this test will need updating — but it
// catches the real failure mode: the CLI rejecting our response.

const cliPermissionResultSchema = z.union([
  z.object({
    behavior: z.literal("allow"),
    updatedInput: z.record(z.string(), z.unknown()),
    updatedPermissions: z.array(z.unknown()).optional(),
    toolUseID: z.string().optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
  }),
]);

// ── Helpers ─────────────────────────────────────────────────

const DUMMY_OPTIONS = {
  signal: new AbortController().signal,
  toolUseID: "tool-use-123",
} as Parameters<ReturnType<typeof createCanUseTool>>[2];

function modeRef(mode = "bypassPermissions") {
  return { current: mode };
}

// ── Allow path: updatedInput must always be present ─────────

describe("canUseTool allow responses", () => {
  const regularTools = [
    ["Edit",  { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" }],
    ["Bash",  { command: "ls -la" }],
    ["Write", { file_path: "/tmp/new.ts", content: "hello" }],
    ["Read",  { file_path: "/tmp/test.ts" }],
    ["Grep",  { pattern: "TODO", path: "/tmp" }],
    ["Glob",  { pattern: "**/*.ts" }],
    ["Agent", { prompt: "do something", description: "test" }],
  ] as const;

  for (const [toolName, input] of regularTools) {
    test(`${toolName} — includes updatedInput with original input`, async () => {
      const canUseTool = createCanUseTool(modeRef());
      const result = await canUseTool(toolName, { ...input }, DUMMY_OPTIONS);

      expect(result.behavior).toBe("allow");
      expect((result as { updatedInput?: unknown }).updatedInput).toEqual(input);
    });
  }

  test("empty input still includes updatedInput as empty object", async () => {
    const canUseTool = createCanUseTool(modeRef());
    const result = await canUseTool("SomeTool", {}, DUMMY_OPTIONS);

    expect(result.behavior).toBe("allow");
    expect((result as { updatedInput?: unknown }).updatedInput).toEqual({});
  });

  test("updatedInput is the same object reference (passthrough, not copy)", async () => {
    const canUseTool = createCanUseTool(modeRef());
    const input = { command: "echo test" };
    const result = await canUseTool("Bash", input, DUMMY_OPTIONS);

    expect((result as { updatedInput?: unknown }).updatedInput).toBe(input);
  });
});

// ── Deny path: Orchestra-handled tools ──────────────────────

describe("canUseTool deny responses", () => {
  const askUserAliases = [
    "AskUserQuestion",
    "AskUserTool",
    "request_user_input",
    "requestUserInput",
    "functions.request_user_input",
  ];

  for (const toolName of askUserAliases) {
    test(`${toolName} — denied with interrupt, no updatedInput`, async () => {
      const canUseTool = createCanUseTool(modeRef());
      const result = await canUseTool(toolName, { question: "What?" }, DUMMY_OPTIONS);

      expect(result.behavior).toBe("deny");
      const deny = result as { behavior: "deny"; message: string; interrupt?: boolean };
      expect(typeof deny.message).toBe("string");
      expect(deny.message.length).toBeGreaterThan(0);
      expect(deny.interrupt).toBe(true);
      // deny must NOT have updatedInput (CLI schema branch mismatch)
      expect((result as Record<string, unknown>).updatedInput).toBeUndefined();
    });
  }

  test("ExitPlanMode — denied with interrupt and descriptive message", async () => {
    const canUseTool = createCanUseTool(modeRef("plan"));
    const result = await canUseTool("ExitPlanMode", {}, DUMMY_OPTIONS);

    expect(result.behavior).toBe("deny");
    const deny = result as { behavior: "deny"; message: string; interrupt?: boolean };
    expect(deny.message).toContain("Plan submitted");
    expect(deny.message).toContain("Do not retry ExitPlanMode");
    expect(deny.interrupt).toBe(true);
  });
});

// ── Permission mode independence ────────────────────────────

describe("canUseTool behavior is consistent across permission modes", () => {
  const modes = ["bypassPermissions", "acceptEdits", "default", "plan"];

  for (const mode of modes) {
    test(`regular tool allowed with updatedInput in ${mode} mode`, async () => {
      const canUseTool = createCanUseTool(modeRef(mode));
      const input = { command: "echo hi" };
      const result = await canUseTool("Bash", input, DUMMY_OPTIONS);

      expect(result.behavior).toBe("allow");
      expect((result as { updatedInput?: unknown }).updatedInput).toEqual(input);
    });

    test(`AskUserQuestion denied in ${mode} mode`, async () => {
      const canUseTool = createCanUseTool(modeRef(mode));
      const result = await canUseTool("AskUserQuestion", {}, DUMMY_OPTIONS);
      expect(result.behavior).toBe("deny");
    });

    test(`ExitPlanMode denied in ${mode} mode`, async () => {
      const canUseTool = createCanUseTool(modeRef(mode));
      const result = await canUseTool("ExitPlanMode", {}, DUMMY_OPTIONS);
      expect(result.behavior).toBe("deny");
    });
  }
});

// ── CLI Zod schema validation ───────────────────────────────
// These tests parse the actual return value against the CLI's Zod schema.
// This is the exact validation that failed before the fix: the CLI would
// reject { behavior: "allow" } because updatedInput was missing.

describe("canUseTool results pass CLI Zod schema validation", () => {
  test("allow response for Edit passes CLI schema", async () => {
    const canUseTool = createCanUseTool(modeRef());
    const input = { file_path: "/tmp/test.ts", old_string: "a", new_string: "b" };
    const result = await canUseTool("Edit", input, DUMMY_OPTIONS);

    const parsed = cliPermissionResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("allow response for Bash passes CLI schema", async () => {
    const canUseTool = createCanUseTool(modeRef());
    const result = await canUseTool("Bash", { command: "echo hi" }, DUMMY_OPTIONS);

    const parsed = cliPermissionResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("allow response with empty input passes CLI schema", async () => {
    const canUseTool = createCanUseTool(modeRef());
    const result = await canUseTool("SomeTool", {}, DUMMY_OPTIONS);

    const parsed = cliPermissionResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("deny response for AskUserQuestion passes CLI schema", async () => {
    const canUseTool = createCanUseTool(modeRef());
    const result = await canUseTool("AskUserQuestion", {}, DUMMY_OPTIONS);

    const parsed = cliPermissionResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("deny response for ExitPlanMode passes CLI schema", async () => {
    const canUseTool = createCanUseTool(modeRef("plan"));
    const result = await canUseTool("ExitPlanMode", {}, DUMMY_OPTIONS);

    const parsed = cliPermissionResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("{ behavior: 'allow' } WITHOUT updatedInput fails CLI schema (the original bug)", () => {
    const buggyResult = { behavior: "allow" as const };
    const parsed = cliPermissionResultSchema.safeParse(buggyResult);

    expect(parsed.success).toBe(false);
  });
});
