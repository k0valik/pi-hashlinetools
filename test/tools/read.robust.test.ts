import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { formatHashlineReadPreview } from "../../src/read";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("read.robust.test.ts - formatHashlineReadPreview", () => {
  const content = "line 1\nline 2\nline 3\nline 4\nline 5";

  it("handles various offset and limit combinations", () => {
    // Basic read
    expect(
      formatHashlineReadPreview(content, { offset: 1, limit: 2 }).text,
    ).toContain("line 1");
    expect(
      formatHashlineReadPreview(content, { offset: 1, limit: 2 }).text,
    ).toContain("line 2");
    expect(
      formatHashlineReadPreview(content, { offset: 1, limit: 2 }).text,
    ).not.toContain("line 3");

    // Offset in middle
    const mid = formatHashlineReadPreview(content, { offset: 3, limit: 2 });
    expect(mid.text).not.toContain("line 2");
    expect(mid.text).toContain("line 3");
    expect(mid.text).toContain("line 4");
    expect(mid.text).not.toContain("line 5");

    // Limit exceeding remaining lines
    const exc = formatHashlineReadPreview(content, { offset: 4, limit: 10 });
    expect(exc.text).toContain("line 4");
    expect(exc.text).toContain("line 5");
    expect(exc.text).not.toContain("Showing lines"); // Should not show continuation hint if EOF reached
  });

  it("handles out-of-bounds offsets", () => {
    const oob = formatHashlineReadPreview(content, { offset: 10 });
    expect(oob.text).toContain("Offset 10 is beyond end of file");
    expect(oob.text).toContain("5 lines total");
  });

  it("verifies raw mode output", () => {
    const raw = formatHashlineReadPreview(content, { offset: 1, plain: true });
    expect(raw.text).toBe(content);
    expect(raw.text).not.toContain("│");
  });

  it("handles special characters and Unicode", () => {
    const unicodeContent = "🚀 emoji\n你好 world\nCafé";
    const result = formatHashlineReadPreview(unicodeContent, { offset: 1 });
    expect(result.text).toContain("🚀 emoji");
    expect(result.text).toContain("你好 world");
    expect(result.text).toContain("Café");
  });

  it("handles different line endings (normalized to LF internally)", () => {
    const mixedEndings = "line1\r\nline2\nline3\rline4";
    // The tool expects normalized LF input
    const normalized = mixedEndings.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const result = formatHashlineReadPreview(normalized, { offset: 1 });
    expect(result.text.split("\n")).toHaveLength(4);
  });
});

describe("read.robust.test.ts - read tool execution", () => {
  it("reads a file with BOM", async () => {
    const content = "\uFEFFline with BOM";
    await withTempFile("bom.txt", content, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "bom.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      expect(result.content[0].text).toContain("line with BOM");
      expect(result.content[0].text).not.toContain("\uFEFF");
    });
  });

  it("reads a very large file and handles truncation", async () => {
    // Generate a file larger than DEFAULT_MAX_LINES (usually 500) or DEFAULT_MAX_BYTES (usually 100KB)
    const largeLines = Array.from({ length: 1000 }, (_, i) =>
      `Line ${i + 1} with some extra padding text to increase byte size.`.repeat(
        2,
      ),
    ).join("\n");

    await withTempFile("large.txt", largeLines, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "large.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      expect(result.details.metrics.truncated).toBe(true);
      expect(result.details.nextOffset).toBeDefined();
      expect(result.content[0].text).toContain("Use offset=");
    });
  });

  it("handles non-UTF-8 bytes warning", async () => {
    // A file with invalid UTF-8 bytes
    const buffer = Buffer.from([0x61, 0x62, 0xff, 0x63, 0x64]); // "ab", invalid, "cd"
    await withTempFile("binary_ish.txt", "", async ({ cwd, path }) => {
      await writeFile(path, buffer);
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "binary_ish.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      expect(result.content[0].text).toContain(
        "Non-UTF-8 bytes shown as U+FFFD",
      );
    });
  });

  it("fails when reading a directory", async () => {
    await withTempFile("dummy", "", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      // Pass the directory instead of a file
      await expect(
        readTool.execute("r1", { path: "." }, undefined, undefined, {
          cwd,
        } as any),
      ).rejects.toThrow(/Path is a directory/);
    });
  });

  it("fails when file is not found", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const readTool = getTool("read");

    await expect(
      readTool.execute(
        "r1",
        { path: "non-existent.txt" },
        undefined,
        undefined,
        { cwd: "/tmp" } as any,
      ),
    ).rejects.toThrow(/File not found/);
  });
});
