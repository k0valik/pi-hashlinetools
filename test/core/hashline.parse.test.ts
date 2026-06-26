import { describe, expect, it } from "vitest";
import {
  computeLineHash,
  hashlineParseText,
  parseLineRef,
} from "../../src/hashline";

describe("parseLineRef", () => {
  it("parses standard LINE#HASH format", () => {
    const hash = computeLineHash(["hello"], 0);
    const ref = parseLineRef(`5#${hash}`);
    expect(ref).toEqual({ line: 5, hash });
  });

  it("parses with trailing content", () => {
    const hash = computeLineHash(["  const x = 1;"], 0);
    const ref = parseLineRef(`10#${hash}│  const x = 1;`);
    expect(ref).toEqual({ line: 10, hash });
  });

  it("tolerates leading >>> markers", () => {
    const hash = computeLineHash(["content"], 0);
    const ref = parseLineRef(`>>> 5#${hash}│content`);
    expect(ref).toEqual({ line: 5, hash });
  });

  it("tolerates leading +/- diff markers", () => {
    const hash = computeLineHash(["content"], 0);
    expect(parseLineRef(`+5#${hash}`)).toEqual({ line: 5, hash });
    expect(parseLineRef(`-5#${hash}`)).toEqual({ line: 5, hash });
  });

  it("throws on invalid format", () => {
    expect(() => parseLineRef("invalid")).toThrow(/Invalid line reference/);
  });

  it("diagnoses missing hash", () => {
    expect(() => parseLineRef("12")).toThrow(/missing hash/i);
  });

  it("diagnoses wrong separator", () => {
    expect(() => parseLineRef("5:AB")).toThrow(/Expected "LINE#HASH"/);
  });

  it("diagnoses invalid hash alphabet", () => {
    expect(() => parseLineRef("12#!!!")).toThrow(/alphabet/i);
  });

  it("diagnoses invalid hash length", () => {
    expect(() => parseLineRef("12#ABCD")).toThrow(/hash must be exactly 3/i);
  });

  it("throws on line 0", () => {
    expect(() => parseLineRef("0#MQ")).toThrow(/must be >= 1/);
  });

  it("prefixes structured errors with [E_BAD_REF]", () => {
    expect(() => parseLineRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
  });
});

describe("hashlineParseText", () => {
  it("returns [] for null", () => {
    expect(hashlineParseText(null)).toEqual([]);
  });

  it("splits string on newline", () => {
    expect(hashlineParseText("a\nb")).toEqual(["a", "b"]);
  });

  it("removes trailing blank line from string input", () => {
    expect(hashlineParseText("a\nb\n")).toEqual(["a", "b"]);
  });

  it("preserves a trailing whitespace-only content line in string input", () => {
    expect(hashlineParseText("a\nb\n  ")).toEqual(["a", "b", "  "]);
  });

  it("passes through array input verbatim", () => {
    const input = ["a", "b"];
    expect(hashlineParseText(input)).toEqual(["a", "b"]);
  });

  it("preserves '# Note:' comment lines (no autocorrection)", () => {
    expect(hashlineParseText(["# Note: important"])).toEqual([
      "# Note: important",
    ]);
  });

  it("preserves literal '+' prefixed content (no autocorrection)", () => {
    expect(hashlineParseText(["+added"])).toEqual(["+added"]);
  });

  it("returns empty string as a single empty line for blank content", () => {
    expect(hashlineParseText("")).toEqual([""]);
  });

  it("strips full LINE#HASH: prefixes from array input", () => {
    const h1 = computeLineHash(["foo"], 0);
    const h2 = computeLineHash(["bar"], 0);
    const result = hashlineParseText([`1#${h1}│foo`, `2#${h2}│bar`]);
    expect(result).toEqual(["foo", "bar"]);
  });

  it("strips diff-preview hunks with + and context hash prefixes", () => {
    const hk = computeLineHash(["keep"], 0);
    const hn = computeLineHash(["new"], 0);
    const ha = computeLineHash(["after"], 0);
    const result = hashlineParseText([
      ` 9#${hk}│keep`,
      `+10#${hn}│new`,
      ` 11#${ha}│after`,
    ]);
    expect(result).toEqual(["keep", "new", "after"]);
  });

  it("drops diff-preview deletion rows (- lines are deletions, not content)", () => {
    const hk = computeLineHash(["keep"], 0);
    const ha = computeLineHash(["after"], 0);
    const result = hashlineParseText([
      ` 9#${hk}│keep`,
      "-10    old",
      ` 11#${ha}│after`,
    ]);
    expect(result).toEqual(["keep", "after"]);
  });

  it("strips string-form rendered diff hunks", () => {
    const hk = computeLineHash(["keep"], 0);
    const hn = computeLineHash(["new"], 0);
    const ha = computeLineHash(["after"], 0);
    const input = ` 9#${hk}│keep\n-10    old\n+10#${hn}│new\n 11#${ha}│after`;
    const result = hashlineParseText(input);
    expect(result).toEqual(["keep", "new", "after"]);
  });

  it("preserves confusable Unicode hyphens verbatim (regression for FIRST §1.1 / SECOND §3.1)", () => {
    // Previously, hashlineParseText folded U+2013, U+2014, U+2212 etc. into
    // ASCII '-'. That corrupted user content silently. The intent of the
    // normalization was to help with content-hint matching, but the actual
    // hint comparison function (`normalizedContentHint`) only trims
    // whitespace, so the confusable-fold was unused for matching while
    // corrupting the new content. Now: keep user content verbatim.
    expect(hashlineParseText(["x \u2013 y", "a\u2014b", "\u2212c"])).toEqual([
      "x \u2013 y",
      "a\u2014b",
      "\u2212c",
    ]);
  });

  it("strips public read output format (LINE#HH│ - no '#' between line number and checksum)", () => {
    // The read tool outputs: " 16AB│content" where 16=line, AB=checksum, no separator
    // bug: stripDisplayPrefixes regex required '#' between line number and checksum
    expect(hashlineParseText(["16AB│const value = 42;"])).toEqual([
      "const value = 42;",
    ]);
    expect(hashlineParseText(["104A│hello world"])).toEqual(["hello world"]);
  });

  it("strips public read output format with leading spaces", () => {
    // Read output pads line numbers, e.g. " 16AB│content"
    expect(hashlineParseText([" 16AB│const value = 42;"])).toEqual([
      "const value = 42;",
    ]);
    expect(hashlineParseText([" 104A│hello"])).toEqual(["hello"]);
  });

  it("strips public read output format with diff '+' and '>>>' markers", () => {
    // Diff output uses + prefix, error output uses >>> prefix
    expect(hashlineParseText(["+104A│added line"])).toEqual(["added line"]);
    expect(hashlineParseText([">>> 104A│relocated line"])).toEqual([
      "relocated line",
    ]);
  });

  it("preserves legitimate file content with digit+2hex+separator patterns", () => {
    // "AB│foo" without line number is NOT a full prefix - preserved (bare prefix, ambiguous)
    expect(hashlineParseText(["AB│foo"])).toEqual(["AB│foo"]);
    // "A│foo" (single letter) is NOT a 2-char checksum - preserved
    expect(hashlineParseText(["A│foo"])).toEqual(["A│foo"]);
    // "12AB: foo" has colon separator (YAML/switch) — no false positive;
    // only │ (U+2502) is accepted for the public read format without #
    expect(hashlineParseText(["12AB: foo"])).toEqual(["12AB: foo"]);
    // "12AB|foo" has pipe separator (markdown table) — no false positive
    expect(hashlineParseText(["12AB|foo"])).toEqual(["12AB|foo"]);
    // Regular content is preserved
    expect(hashlineParseText(["const x = 1;"])).toEqual(["const x = 1;"]);
  });

  it("strips string-form public read output format", () => {
    const input = " 16AB│const value = 42;\n 17CD│return value;";
    const result = hashlineParseText(input);
    expect(result).toEqual(["const value = 42;", "return value;"]);
  });
});
