import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAutoRead, createAutoReadHandler } from "../../index";

// ── Temp dir helper ──────────────────────────────────────────────────────

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-hashline-autoread-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeFakeEvent(
  overrides: Partial<{
    content: Array<{ type: "text"; text: string }>;
    path: string;
    isError: boolean;
    toolName: string;
  }> = {},
): {
  content?: Array<{ type: "text"; text: string }>;
  input: Record<string, unknown>;
  isError: boolean;
  toolName: string;
} {
  return {
    content: overrides.content ?? [],
    input: { path: overrides.path ?? "/nonexistent" },
    isError: overrides.isError ?? false,
    toolName: overrides.toolName ?? "",
  };
}

// ── appendAutoRead integration tests ─────────────────────────────────────

describe("appendAutoRead", () => {
  it("appends hashline-anchored content for a small file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "const a = 1;\nconst b = 2;\n", "utf-8");

      const event = makeFakeEvent({ path: filePath });
      const result = await appendAutoRead(event, { cwd: dir });

      expect(result).toBeDefined();
      expect(result?.content).toBeDefined();

      const texts =
        result?.content
          ?.filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text) ?? [];
      const fullText = texts.join("");
      expect(fullText).toContain("--- Auto-read (hashline anchors) ---");
      expect(fullText).toMatch(/1#\S{3}│const a = 1;/);
      expect(fullText).toMatch(/2#\S{3}│const b = 2;/);
    });
  });

  it("returns undefined when path is missing", async () => {
    const event = makeFakeEvent({ path: undefined as unknown as string });
    const result = await appendAutoRead(event, { cwd: "/tmp" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when path is not a string", async () => {
    const event = {
      content: [],
      input: { path: 42 },
    } as unknown as Parameters<typeof appendAutoRead>[0];
    const result = await appendAutoRead(event, { cwd: "/tmp" });
    expect(result).toBeUndefined();
  });

  it("returns undefined silently when file does not exist", async () => {
    const event = makeFakeEvent({ path: "/tmp/nonexistent-file-xyzzy123" });
    const result = await appendAutoRead(event, { cwd: "/tmp" });
    expect(result).toBeUndefined();
  });

  it("preserves existing event content", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "const x = 1;\n", "utf-8");

      const event = makeFakeEvent({
        path: filePath,
        content: [{ type: "text", text: "Edit applied successfully." }],
      });
      const result = await appendAutoRead(event, { cwd: dir });

      expect(result).toBeDefined();
      const texts =
        result?.content
          ?.filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text) ?? [];
      expect(texts[0]).toBe("Edit applied successfully.");
      expect(texts[1]).toContain("--- Auto-read (hashline anchors) ---");
    });
  });

  it("handles files ending with newline (no empty sentinel line)", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      // File with trailing newline — should produce 2 visible lines, no sentinel
      await writeFile(filePath, "line1\nline2\n", "utf-8");

      const event = makeFakeEvent({ path: filePath });
      const result = await appendAutoRead(event, { cwd: dir });

      expect(result).toBeDefined();
      const texts =
        result?.content
          ?.filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text) ?? [];
      const fullText = texts.join("");
      expect(fullText).toMatch(/1#\S{3}│line1/);
      expect(fullText).toMatch(/2#\S{3}│line2/);
      expect(fullText).not.toMatch(/3#\S{3}│$/m);
    });
  });

  it("handles absolute paths directly", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "export {};\n", "utf-8");

      const event = makeFakeEvent({ path: filePath });
      const result = await appendAutoRead(event, { cwd: "/some/other/dir" });

      expect(result).toBeDefined();
      const texts =
        result?.content
          ?.filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text) ?? [];
      expect(texts.join("")).toContain("--- Auto-read (hashline anchors) ---");
    });
  });
});

// ── Auto-read gate (v2 plan) ────────────────────────────────────
//
// The auto-read is unconditional on commit when the gate is enabled.
// No more regex matching warning codes — the gate is a boolean.

describe("createAutoReadHandler — gate behavior", () => {
  it("appends auto-read on edit when gate is enabled, regardless of warnings", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "const x = 1;\n", "utf-8");

      const handler = createAutoReadHandler(() => true);
      const result = await handler(
        makeFakeEvent({
          path: filePath,
          toolName: "edit",
          content: [{ type: "text", text: "1 insertion(+), 0 deletions(-)" }],
        }),
        { cwd: dir },
      );
      expect(result).toBeDefined();
      const texts =
        (result as any)?.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text) ?? [];
      expect(texts.join("")).toContain("--- Auto-read (hashline anchors) ---");
    });
  });

  it("does NOT append auto-read on edit when gate is disabled", async () => {
    const handler = createAutoReadHandler(() => false);
    const result = await handler(
      makeFakeEvent({
        path: "/tmp/whatever",
        toolName: "edit",
        content: [{ type: "text", text: "1 insertion(+), 0 deletions(-)" }],
      }),
      { cwd: "/tmp" },
    );
    expect(result).toBeUndefined();
  });

  it("does NOT append auto-read on write when gate is disabled", async () => {
    const handler = createAutoReadHandler(() => false);
    const result = await handler(
      makeFakeEvent({
        path: "/tmp/whatever",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
      }),
      { cwd: "/tmp" },
    );
    expect(result).toBeUndefined();
  });

  it("appends auto-read on write when gate is enabled", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "const y = 2;\n", "utf-8");

      const handler = createAutoReadHandler(() => true);
      const result = await handler(
        makeFakeEvent({
          path: filePath,
          toolName: "write",
          content: [{ type: "text", text: "ok" }],
        }),
        { cwd: dir },
      );
      expect(result).toBeDefined();
    });
  });

  it("does NOT append when the tool result is an error", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.ts");
      await writeFile(filePath, "const z = 3;\n", "utf-8");

      const handler = createAutoReadHandler(() => true);
      const result = await handler(
        makeFakeEvent({
          path: filePath,
          toolName: "edit",
          isError: true,
        }),
        { cwd: dir },
      );
      expect(result).toBeUndefined();
    });
  });
});
