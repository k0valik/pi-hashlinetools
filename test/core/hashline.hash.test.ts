import { describe, expect, it } from "vitest";
import {
  applyHashlineEdits,
  computeLineHash,
  computeLineHashes,
  hashlineParseText,
} from "../../src/hashline";

describe("computeLineHashes", () => {
  it("returns an array of 3-char base64 hashes, one per line", () => {
    const content = "a\nb\nc";
    const hashes = computeLineHashes(content);
    expect(hashes).toHaveLength(3);
    for (const h of hashes) {
      expect(h).toHaveLength(3);
      expect(h).toMatch(/^[A-Za-z0-9_-]{3}$/);
    }
  });

  it("produces unique hashes for byte-identical lines with identical neighbors", () => {
    // Two break; lines with the same surrounding context
    const content = [
      "function foo() {",
      "  for (let i = 0; i < n; i++) {",
      "    if (x) {",
      "      break;",
      "    }",
      "  }",
      "  for (let i = 0; i < n; i++) {",
      "    if (x) {",
      "      break;",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const hashes = computeLineHashes(content);
    // All hashes must be unique
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(hashes.length);

    // The two break; lines are identical content with identical neighbors
    // They should get different anchors thanks to collision resolution
    const lines = content.split("\n");
    const breakIdx1 = lines.indexOf("      break;", 0);
    const breakIdx2 = lines.indexOf("      break;", breakIdx1 + 1);
    expect(breakIdx2).toBeGreaterThan(breakIdx1); // second occurrence exists
    expect(hashes[breakIdx1!]).not.toBe(hashes[breakIdx2!]);
  });

  it("is deterministic for the same file content", () => {
    const content = "x\ny\nz";
    const h1 = computeLineHashes(content);
    const h2 = computeLineHashes(content);
    expect(h1).toEqual(h2);
  });
});
describe("computeLineHash", () => {
  it("returns a 3-character URL-safe base64 string", () => {
    const hash = computeLineHash(["hello"], 0);
    expect(hash).toHaveLength(3);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{3}$/);
  });

  it("trims trailing whitespace without collapsing internal spaces", () => {
    expect(computeLineHash(["a\t"], 0)).toBe(computeLineHash(["a"], 0));
    expect(computeLineHash(["a  b"], 0)).not.toBe(computeLineHash(["a b"], 0));
  });

  it("strips trailing CR", () => {
    expect(computeLineHash(["hello\r"], 0)).toBe(computeLineHash(["hello"], 0));
  });

  it("produces same hash for same content with same neighbors", () => {
    const h1 = computeLineHash(["prev", "}", "next"], 1);
    const h2 = computeLineHash(["prev", "}", "next"], 1);
    expect(h1).toBe(h2);
  });

  it("is unaffected by changes to unrelated lines (content-only hash)", () => {
    const file = ["lineA", "lineB", "lineC"];
    const hashBefore = computeLineHash(file, 1);

    // Edit lineA - should not affect lineB's hash
    const fileAfter = ["lineA-edited", "lineB", "lineC"];
    const hashAfter = computeLineHash(fileAfter, 1);

    expect(hashBefore).toBe(hashAfter);
  });
});

describe("strict hashline contract", () => {
  it("preserves internal spaces when hashing", () => {
    expect(computeLineHash(["a b"], 0)).not.toBe(computeLineHash(["ab"], 0));
  });

  it("trims trailing spaces when hashing", () => {
    expect(computeLineHash(["value  "], 0)).toBe(computeLineHash(["value"], 0));
  });

  it("preserves explicit blank trailing line in array input", () => {
    expect(hashlineParseText(["alpha", ""])).toEqual(["alpha", ""]);
  });

  it("rejects stale anchors instead of relocating by hash", () => {
    const fileLines = ["a", "INSERTED", "b", "target", "c"];
    const content = fileLines.join("\n");
    const stale = {
      op: "replace",
      pos: { line: 3, hash: computeLineHash(fileLines, 3) },
      lines: ["updated"],
    };

    expect(() => applyHashlineEdits(content, [stale as any])).toThrow(
      /1 stale anchor: 3#[A-Za-z0-9_-]+\./,
    );
  });
});
