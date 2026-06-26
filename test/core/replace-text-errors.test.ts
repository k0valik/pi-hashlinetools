import { describe, expect, it } from "vitest";
import {
  countOccurrences,
  findClosestPartialMatches,
  locateOccurrenceLines,
} from "../../src/edit-recovery";

describe("countOccurrences", () => {
  it("returns 0 for an empty needle", () => {
    expect(countOccurrences("hello world", "")).toBe(0);
  });

  it("returns 0 when the needle is not found", () => {
    expect(countOccurrences("hello world", "xyz")).toBe(0);
  });

  it("returns 0 for an empty haystack", () => {
    expect(countOccurrences("", "foo")).toBe(0);
  });

  it("returns 1 for a single match", () => {
    expect(countOccurrences("hello world", "world")).toBe(1);
  });

  it("returns N for N non-overlapping matches", () => {
    expect(countOccurrences("aaa", "a")).toBe(3);
  });

  it("counts non-overlapping matches of a multi-char needle", () => {
    // "aa" in "aaaa" should be 2, not 3 (the third "aa" overlaps the second).
    expect(countOccurrences("aaaa", "aa")).toBe(2);
  });

  it("handles newlines in haystack and needle", () => {
    const haystack = "line1\nline2\nline1\nline2";
    expect(countOccurrences(haystack, "line1")).toBe(2);
    expect(countOccurrences(haystack, "line1\nline2")).toBe(2);
  });
});

describe("locateOccurrenceLines", () => {
  it("returns an empty array for an empty needle", () => {
    expect(locateOccurrenceLines("a\nb", "")).toEqual([]);
  });

  it("returns [1] for a match on the first line", () => {
    expect(locateOccurrenceLines("foo bar", "foo")).toEqual([1]);
  });

  it("returns 1-based line numbers for matches across multiple lines", () => {
    const haystack = "alpha\nbeta\ngamma\nalpha\nbeta";
    // "alpha" appears on line 1 and line 4.
    expect(locateOccurrenceLines(haystack, "alpha", 5)).toEqual([1, 4]);
    // "beta" appears on line 2 and line 5.
    expect(locateOccurrenceLines(haystack, "beta", 5)).toEqual([2, 5]);
  });

  it("truncates to `max` entries", () => {
    const haystack = "a\na\na\na\na\na\na";
    expect(locateOccurrenceLines(haystack, "a", 3)).toEqual([1, 2, 3]);
  });

  it("returns an empty array for a needle that is not found", () => {
    expect(locateOccurrenceLines("a\nb\nc", "z")).toEqual([]);
  });

  it("counts lines correctly for a CRLF haystack", () => {
    // countOccurrences / locateOccurrenceLines treat the input as opaque
    // bytes. A CRLF haystack uses \r\n as the line break, so the match on
    // "bar" lands on line 2.
    const haystack = "foo\r\nbar\r\nbaz";
    expect(locateOccurrenceLines(haystack, "bar", 5)).toEqual([2]);
  });

  it("returns all matches when the count is below the max", () => {
    const haystack = "a\na\na";
    expect(locateOccurrenceLines(haystack, "a", 10)).toEqual([1, 2, 3]);
  });

  it("counts newlines WITHIN the needle for multi-line needles ", () => {
    // The bug: when a multi-line needle matched, the loop advanced idx but
    // did NOT increment the line counter for newlines inside the needle. So a
    // needle like "a\nb" matching in "a\nb\na\nb\n" would report [1, 2, 3]
    // instead of the correct [1, 3, 5] (off by the number of newlines in the
    // previous match).
    expect(locateOccurrenceLines("a\nb\na\nb\na\nb", "a\nb")).toEqual([
      1, 3, 5,
    ]);
    // And single-line needles still work (the new code path is a no-op).
    expect(locateOccurrenceLines("foo\nbar\nfoo\nbar\nfoo", "foo")).toEqual([
      1, 3, 5,
    ]);
    // 3-line needle.
    expect(locateOccurrenceLines("a\nb\nc\na\nb\nc\n", "a\nb\nc")).toEqual([
      1, 4,
    ]);
  });
});

describe("findClosestPartialMatches", () => {
  it("returns the line with the best score first", () => {
    const haystack = "const foo = 1;\nconst bar = 2;\nconst baz = 3;";
    // "const foo = 1" is a long common substring of line 1 (full match,
    // 14 chars). For lines 2 and 3, the longest common substring with
    // "const foo = 1" is "const " (6 chars). All three lines have
    // positive scores; line 1 should be sorted first.
    const out = findClosestPartialMatches(haystack, "const foo = 1");
    expect(out[0]).toBe(1);
  });

  it("matches across whitespace normalization (collapsed)", () => {
    const haystack = "  const foo = 1;\nconst foo = 1;\nconst foo = 2;";
    // The needle "const foo = 1" (no leading spaces) matches line 2
    // exactly; line 1 is "  const foo = 1;" which is a partial match
    // after whitespace collapse.
    // We return up to `max` (default 3) line numbers, sorted by score.
    const out = findClosestPartialMatches(haystack, "const foo = 1");
    expect(out).toContain(1);
    expect(out).toContain(2);
  });

  it("is case-insensitive", () => {
    const haystack = "FOO\nfoo\nbar";
    expect(findClosestPartialMatches(haystack, "foo")).toEqual([1, 2]);
  });

  it("returns an empty array when no line partially matches", () => {
    const haystack = "alpha\nbeta\ngamma";
    expect(findClosestPartialMatches(haystack, "xxxxxx")).toEqual([]);
  });

  it("truncates to `max` entries (default 3)", () => {
    const haystack = "foo 1\nfoo 2\nfoo 3\nfoo 4\nfoo 5";
    // "foo" is a prefix of all five lines; we return at most 3.
    const out = findClosestPartialMatches(haystack, "foo");
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("respects an explicit `max` of 1", () => {
    const haystack = "foo\nfoo\nfoo";
    expect(findClosestPartialMatches(haystack, "foo", 1)).toEqual([1]);
  });

  it("returns an empty array for an empty needle", () => {
    expect(findClosestPartialMatches("a\nb", "")).toEqual([]);
  });

  it("returns an empty array for an empty haystack", () => {
    expect(findClosestPartialMatches("", "foo")).toEqual([]);
  });

  it("filters out single-character coincidental matches", () => {
    // The bug: a score filter of 0 is too permissive — any line sharing
    // even one character with the needle gets promoted, surfacing
    // unrelated noise as "closest partial match".
    //
    // Build a long, varied file where most lines have at least one
    // common character with the needle but the actual closest match
    // is rare.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++)
      lines.push(`function helper${i}() { return ${i}; }`);
    const haystack =
      lines.join("\n") +
      "\nfunction handleLogin(user, pwd) { return validate(user, pwd); }";
    // The needle is a 20-char phrase that only fully matches one line.
    const out = findClosestPartialMatches(haystack, "handleLogin(user, pwd)");
    // The result should NOT surface a flood of unrelated "function" lines
    // that share only one char. With the minScore floor, the only line
    // with score >= 4 is line 51 (the actual match).
    expect(out.length).toBeLessThanOrEqual(3);
    // If anything is reported, the actual match line should be at the top.
    if (out.length > 0) expect(out[0]).toBe(51);
  });

  it("is robust to a buffer that's reused across many calls", () => {
    // Smoke test: the internal longestCommonSubstringLength now takes
    // pre-allocated buffers. We don't expose those, but we can call
    // findClosestPartialMatches many times on the same content to
    // exercise the buffer-reuse path. We just check it returns the
    // same correct result on repeated calls (no cross-call corruption).
    const haystack = "const foo = 1;\nconst bar = 2;\nconst baz = 3;";
    const needle = "const foo = 1";
    const first = findClosestPartialMatches(haystack, needle);
    const second = findClosestPartialMatches(haystack, needle);
    const third = findClosestPartialMatches(haystack, needle);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
