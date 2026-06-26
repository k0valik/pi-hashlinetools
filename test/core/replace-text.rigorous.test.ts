import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { applyReplaceTextEdits } from "../../src/edit";

describe("applyReplaceTextEdits - Rigorous Testing", () => {
  const path = "test.txt";

  describe("Backslash Normalization", () => {
    it('handles model-provided " for literal \\" in file', () => {
      const content = 'const x = \\"hello\\";';
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: 'const x = "hello";', // Model might omit backslashes
          newText: 'const x = "world";',
        },
      ];
      const rawBuffer = Buffer.from(content, "utf-8");
      const result = applyReplaceTextEdits(content, edits, path, rawBuffer);
      // It should match the literal \" in the file.
      // Note: result will have bare " because newText has bare ".
      expect(result).toBe('const x = "world";');
    });

    it('handles model-provided bare \\" for literal \\" in file', () => {
      const content = 'const x = \\"hello\\";';
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: 'const x = \\"hello\\";',
          newText: 'const x = \\"world\\";',
        },
      ];
      const rawBuffer = Buffer.from(content, "utf-8");
      const result = applyReplaceTextEdits(content, edits, path, rawBuffer);
      expect(result).toBe('const x = \\"world\\";');
    });

    it("does not throw when one variant matches uniquely even if others exist", () => {
      const content = 'const x = "hello"; const y = \\"hello\\";';
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: 'const x = "hello";',
          newText: 'const x = "world";',
        },
      ];
      const rawBuffer = Buffer.from(content, "utf-8");
      const result = applyReplaceTextEdits(content, edits, path, rawBuffer);
      expect(result).toBe('const x = "world"; const y = \\"hello\\";');
    });
  });

  describe("Byte-level Recovery (via tryRecovery)", () => {
    it("recovers from LF/CRLF mismatch in oldText with W_AUTO_RECOVERY", () => {
      const content = "line1\nline2\n"; // Normalized content
      const rawBuffer = Buffer.from("line1\nline2\n", "utf-8");
      const warnings: string[] = [];
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: "line1\r\nline2", // Model provided CRLF but file has LF
          newText: "changed",
        },
      ];
      const result = applyReplaceTextEdits(
        content,
        edits,
        path,
        rawBuffer,
        warnings,
      );
      expect(result).toBe("changed\n");
      expect(warnings[0]).toContain("[W_AUTO_RECOVERY]");
      // User-facing text was cleaned up: the internal strategy name
      // (e.g. "lf-normalized", "trimmed") is no longer leaked. The
      // warning now just says "after applying whitespace/line-ending
      // tolerance" — the model doesn't need to know which strategy won.
      expect(warnings[0]).toMatch(
        /after applying whitespace\/line-ending tolerance/,
      );
    });

    it("recovers from trailing whitespace via tryRecovery when exact match fails", () => {
      const content = "line1 \nline2\n";
      const rawBuffer = Buffer.from(content, "utf-8");
      const warnings: string[] = [];
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: "line1\nline2", // missing the space
          newText: "changed",
        },
      ];
      const result = applyReplaceTextEdits(
        content,
        edits,
        path,
        rawBuffer,
        warnings,
      );
      expect(result).toBe("changed\n");
      expect(warnings[0]).toContain("[W_AUTO_RECOVERY]");
      // User-facing text was cleaned up: the internal strategy name
      // (e.g. "lf-normalized", "trimmed") is no longer leaked.
      expect(warnings[0]).toMatch(
        /after applying whitespace\/line-ending tolerance/,
      );
    });
  });

  describe("Edge Cases", () => {
    it("handles BOM correctly", () => {
      const bom = "\uFEFF";
      const content = "hello world";
      const rawBuffer = Buffer.from(bom + content, "utf-8");
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: "hello",
          newText: "hi",
        },
      ];
      const result = applyReplaceTextEdits(content, edits, path, rawBuffer);
      expect(result).toBe("hi world");
    });

    it("throws E_REPLACE_TEXT_NOT_FOUND when match is missing", () => {
      const content = "hello world";
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: "missing",
          newText: "replacement",
        },
      ];
      expect(() => applyReplaceTextEdits(content, edits, path)).toThrow(
        "[E_REPLACE_TEXT_NOT_FOUND]",
      );
    });

    it("throws E_REPLACE_TEXT_NOT_UNIQUE for multiple exact matches", () => {
      const content = "foo foo bar";
      const edits = [
        {
          op: "replace_text" as const,
          pos: "",
          oldText: "foo",
          newText: "baz",
        },
      ];
      expect(() => applyReplaceTextEdits(content, edits, path)).toThrow(
        "[E_REPLACE_TEXT_NOT_UNIQUE]",
      );
    });
  });
});
