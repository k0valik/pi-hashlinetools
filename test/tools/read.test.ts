import { beforeEach, describe, expect, it, vi } from "vitest";
import register from "../../index";
import { formatHashlineReadPreview } from "../../src/read";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
  loadFileKindAndText: vi.fn(),
  classifyFileKind: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

describe("formatHashlineReadPreview", () => {
  it("reports an oversized first line", () => {
    const longLine = "x".repeat(70_000);
    const result = formatHashlineReadPreview(longLine, { offset: 1 });

    expect(result.text).toContain("Line 1 exceeds");
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.truncation?.firstLineExceedsLimit).toBe(true);
  });

  it("formats ordinary lines with line numbers", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 1 });

    expect(result.text).toMatch(/1[A-Za-z0-9_\\-]{3}│alpha/);
  });

  it("pads line numbers to the same width within the returned block", () => {
    const allLines = Array.from(
      { length: 10 },
      (_, index) => `line-${index + 1}`,
    );
    const text = allLines.join("\n");
    const result = formatHashlineReadPreview(text, { offset: 8 });

    const lines = result.text.split("\n").slice(0, 3);
    // Check that the format has 2-char hex checksum and padded line numbers
    expect(lines[0]).toMatch(/^\s*8[A-Za-z0-9_\\-]{3}│line-8$/);
    expect(lines[1]).toMatch(/^\s*9[A-Za-z0-9_\\-]{3}│line-9$/);
    expect(lines[2]).toMatch(/^10[A-Za-z0-9_\\-]{3}│line-10$/);
  });

  it("returns an advisory for empty files instead of a synthetic empty-line anchor", () => {
    const result = formatHashlineReadPreview("", { offset: 1 });

    expect(result.text).toContain("File is empty");
    expect(result.text).toContain("write tool");
    expect(result.text).not.toContain("1│");
  });

  it("hides the terminal newline sentinel from preview output", () => {
    const result = formatHashlineReadPreview("alpha\nbeta\n", { offset: 1 });

    expect(result.text).toMatch(/1[A-Za-z0-9_\\-]{3}│alpha/);
    expect(result.text).toMatch(/2[A-Za-z0-9_\\-]{3}│beta/);
    expect(result.text).not.toMatch(/3[A-Za-z0-9_\\-]{3}│/);
    expect(result.text).not.toContain("2 lines total");
  });

  it("keeps continuation hints for partial previews", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", {
      offset: 1,
      limit: 1,
    });

    expect(result.text).toContain("Use offset=2 to continue");
  });

  it("reports when offset is beyond end of content", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 10 });

    expect(result.text).toContain("Offset 10 is beyond end of file");
    expect(result.text).toContain("2 lines total");
  });

  it("rejects fractional offsets", () => {
    expect(() =>
      formatHashlineReadPreview("alpha\nbeta", { offset: 1.5 }),
    ).toThrow(/offset.*positive integer/i);
  });

  it("rejects non-positive limits", () => {
    expect(() =>
      formatHashlineReadPreview("alpha\nbeta", { limit: 0 }),
    ).toThrow(/limit.*positive integer/i);
  });
});

describe("read tool protocol", () => {
  beforeEach(() => {
    vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
    vi.mocked(fileKindMod.classifyFileKind).mockReset();
  });

  it("returns the empty-file advisory through the registered tool", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "",
      });

      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "empty.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("File is empty");
      expect(result.content[0].text).not.toContain("1#");
    });
  });

  it("omits the trailing newline sentinel through the registered tool", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "alpha\nbeta\n",
      });

      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("│alpha");
      expect(result.content[0].text).toContain("│beta");
      expect(result.content[0].text).not.toMatch(/3[A-Za-z0-9_\\-]{3}│/);
    });
  });

  it("uses the shared text loader instead of classifying then re-reading text files", async () => {
    await withTempFile("sample.txt", "ignored\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "alpha\nbeta\n",
      });
      vi.mocked(fileKindMod.classifyFileKind).mockRejectedValue(
        new Error("read tool should not call classifyFileKind on text paths"),
      );

      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("│alpha");
      expect(result.content[0].text).toContain("│beta");
      expect(vi.mocked(fileKindMod.classifyFileKind)).not.toHaveBeenCalled();
    });
  });
});
