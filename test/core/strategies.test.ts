import { describe, expect, it } from "vitest";
import {
  tryByteRelocate,
  tryFuzzyRelocate,
  tryResolveCompactRef,
} from "../../src/edit-strategies";

describe("tryFuzzyRelocate (Layer 2 fuzzy)", () => {
  it("returns null when no match in the window", () => {
    const fileLines = ["aaa", "bbb", "ccc", "ddd"];
    const result = tryFuzzyRelocate("zzz", 2, fileLines, 4, 40);
    expect(result).toBeNull();
  });

  it("returns null at the expected line (skips self)", () => {
    const fileLines = ["aaa", "bbb", "ccc"];
    // expected="bbb" matches line 2, but we skip self
    const result = tryFuzzyRelocate("bbb", 2, fileLines, 3, 40);
    expect(result).toBeNull();
  });

  it("returns the unique match within the radius", () => {
    const fileLines = ["aaa", "bbb", "ccc", "ddd", "eee"];
    // expected="ccc" appears at line 3, but we're asking from line 1
    const result = tryFuzzyRelocate("ccc", 1, fileLines, 5, 40);
    expect(result).toBe(3);
  });

  it("returns null when multiple matches in the window (ambiguous)", () => {
    const fileLines = ["foo", "bar", "foo", "bar", "foo"];
    // expected="foo" appears at lines 1, 3, 5 — ambiguous
    const result = tryFuzzyRelocate("foo", 2, fileLines, 5, 40);
    expect(result).toBeNull();
  });

  it("respects the radius limit", () => {
    const fileLines = ["aaa", "bbb", "ccc", "ddd", "eee", "fff"];
    // expected="fff" is at line 6, radius=2 from line 1 → not in window
    const result = tryFuzzyRelocate("fff", 1, fileLines, 6, 2);
    expect(result).toBeNull();
  });

  it("returns the match on the other side of expected line", () => {
    const fileLines = ["aaa", "bbb", "ccc", "ddd"];
    // expected="aaa" appears at line 1; we ask from line 4
    const result = tryFuzzyRelocate("aaa", 4, fileLines, 4, 40);
    expect(result).toBe(1);
  });
});

describe("tryByteRelocate (Layer 5 byte-level)", () => {
  it("returns kind: 'none' for empty buffer", () => {
    const buf = Buffer.from("");
    const result = tryByteRelocate(buf, "anything", 0);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns kind: 'none' for empty contentHint ", () => {
    // Without the guard, Buffer.from("", "utf-8") would match at every byte
    // position, returning a spurious match. The guard short-circuits.
    const buf = Buffer.from("hello world\n");
    const result = tryByteRelocate(buf, "", 2);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns kind: 'none' when needle is not found", () => {
    const buf = Buffer.from("hello world\n");
    const result = tryByteRelocate(buf, "missing", 2);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns kind: 'none' when needle appears at a non-line-start position", () => {
    // "world" appears in the middle of "hello world", not at a line start
    const buf = Buffer.from("hello world\n");
    const result = tryByteRelocate(buf, "world", 2);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns kind: 'found' with the line number for a unique line-start match", () => {
    const buf = Buffer.from("aaa\nbbb\nccc\n");
    const result = tryByteRelocate(buf, "bbb", 3);
    expect(result).toEqual({ kind: "found", line: 2 });
  });

  it("returns kind: 'ambiguous' when needle appears on multiple lines ", () => {
    // Previously, this case returned null, which the orchestrator surfaced
    // as E_LINE_CHANGED (misleading — suggested stale context
    // rather than duplicate content). Now: kind: "ambiguous" propagates
    // through the medley and the orchestrator emits E_RELOCATE_AMBIGUOUS.
    const buf = Buffer.from("foo\nfoo\nfoo\n");
    const result = tryByteRelocate(buf, "foo", 3);
    expect(result).toEqual({ kind: "ambiguous", count: 3 });
  });

  it("handles BOM at file start", () => {
    // BOM (0xef 0xbb 0xbf) + content
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("aaa\nbbb\nccc\n"),
    ]);
    // "aaa" is at line 1 (after BOM), should be found
    const result = tryByteRelocate(buf, "aaa", 3);
    expect(result).toEqual({ kind: "found", line: 1 });
  });

  it("handles CRLF line endings", () => {
    const buf = Buffer.from("aaa\r\nbbb\r\nccc\r\n");
    // "bbb" is at line 2 (CRLF counts as one line break)
    const result = tryByteRelocate(buf, "bbb", 3);
    expect(result).toEqual({ kind: "found", line: 2 });
  });

  it("returns kind: 'none' when line number is out of visible range", () => {
    // "ccc" is at line 3, but visibleLineCount=2 → out of range
    const buf = Buffer.from("aaa\nbbb\nccc\n");
    const result = tryByteRelocate(buf, "ccc", 2);
    expect(result).toEqual({ kind: "none" });
  });
});

describe("tryResolveCompactRef (compact ref resolver)", () => {
  it("returns the resolved anchor for a valid bare line number", () => {
    const fileLines = ["aaa", "bbb", "ccc"];
    const warnings: string[] = [];
    const result = tryResolveCompactRef(
      "2",
      fileLines,
      3,
      "range start",
      warnings,
    );
    expect(result).toMatch(/^2#[\w-]{3}$/);
    expect(warnings).toHaveLength(1);
  });

  it("returns undefined for an out-of-range line", () => {
    const fileLines = ["aaa", "bbb"];
    const warnings: string[] = [];
    const result = tryResolveCompactRef(
      "99",
      fileLines,
      2,
      "range start",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("returns undefined for invalid input", () => {
    const fileLines = ["aaa"];
    const warnings: string[] = [];
    const result = tryResolveCompactRef(
      "not a number",
      fileLines,
      1,
      "range start",
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("includes the label in the warning", () => {
    const fileLines = ["aaa", "bbb"];
    const warnings: string[] = [];
    tryResolveCompactRef("2", fileLines, 2, "range end", warnings);
    expect(warnings[0]).toContain("range end");
  });
});
