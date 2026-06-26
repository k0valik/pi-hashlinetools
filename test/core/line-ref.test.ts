import { describe, expect, it } from "vitest";
import {
  formatPublicLineRef,
  parsePublicLineRef,
  publicChecksumFromHash,
} from "../../src/line-ref";

describe("line-ref", () => {
  describe("publicChecksumFromHash", () => {
    it("returns the 3-char hash unchanged (full hash is the public checksum)", () => {
      const hash1 = "aB3";
      const hash2 = "_zA";
      const hash3 = "0_a";

      expect(publicChecksumFromHash(hash1)).toBe("aB3");
      expect(publicChecksumFromHash(hash2)).toBe("_zA");
      expect(publicChecksumFromHash(hash3)).toBe("0_a");
    });
  });

  describe("parsePublicLineRef", () => {
    it("parses 3-char base64 checksum format (NN###│content)", () => {
      const result = parsePublicLineRef("25_aB│[yonilerner]");
      expect(result).toEqual({
        line: 25,
        checksum: "_aB",
        contentHint: "[yonilerner]",
      });
    });

    it("parses bare line number", () => {
      const result = parsePublicLineRef("42");
      expect(result).toEqual({ line: 42 });
    });

    it("parses with leading markers", () => {
      const result = parsePublicLineRef("  > 25_aB│content");
      expect(result).toEqual({
        line: 25,
        checksum: "_aB",
        contentHint: "content",
      });
    });

    it("parses 3-char base64 with # separator (regression — emitted by appendAutoRead)", () => {
      // The AJV schema accepts both "25_aB│content" and "25#_aB│content".
      // The latter is what appendAutoRead emits via formatHashlineRegion.
      const result = parsePublicLineRef("25#_aB│[yonilerner]");
      expect(result).toEqual({
        line: 25,
        checksum: "_aB",
        contentHint: "[yonilerner]",
      });
    });
  });

  describe("formatPublicLineRef", () => {
    it("generates 3-char base64 checksum format", () => {
      const fileLines = ["aaa", "bbb", "ccc"];
      const result = formatPublicLineRef(fileLines, 2);

      // Should be in format "2###" (line number + 3-char base64)
      expect(result).toHaveLength(4); // "2" + 3 chars
      expect(result).toMatch(/^2[A-Za-z0-9_-]{3}$/);
    });
  });
});
