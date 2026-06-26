import { describe, expect, it } from "vitest";
import {
  type Anchor,
  applyHashlineEdits,
  computeLineHash,
  type HashlineToolEdit,
  resolveEditAnchors,
} from "../../src/hashline";

function makeTag(content: string, lineNum: number): Anchor {
  const fileLines = content.split("\n");
  return { line: lineNum, hash: computeLineHash(fileLines, lineNum - 1) };
}

describe("applyHashlineEdits — error handling", () => {
  it("throws on hash mismatch", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      { op: "replace", pos: { line: 2, hash: "XX" }, lines: ["BBB"] },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(
      /1 stale anchor: 2#XX\./,
    );
  });

  it("throws on out-of-range line", () => {
    const content = "aaa\nbbb";
    const edits = [
      { op: "replace", pos: { line: 99, hash: "AB" }, lines: ["x"] },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(
      /past the end of the file/,
    );
  });

  it("throws on range start > end", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 3),
        end: makeTag(content, 1),
        lines: ["x"],
      },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(
      /must be <= end line/,
    );
  });

  it("reports multiple mismatches at once", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      { op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
      { op: "replace", pos: { line: 3, hash: "YY" }, lines: ["C"] },
    ];
    expect(() => applyHashlineEdits(content, edits as any)).toThrow(
      /2 stale anchors: 1#XX, 3#YY\./,
    );
  });

  it("mismatch message exposes retryable >>> LINE#HASH snippets", () => {
    expect(() =>
      applyHashlineEdits("aaa", [
        {
          op: "replace",
          pos: { line: 1, hash: "AB" },
          lines: ["bbb"],
        } as any,
      ]),
    ).toThrow(/>>> 1#[A-Za-z0-9_-]{3}│aaa/);
  });

  it("retains still-valid range endpoints in retry snippets", () => {
    const content = "aaa\nbbb\nccc\nddd\neee";
    const validEnd = makeTag(content, 5);

    try {
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: { line: 1, hash: "AB" },
          end: validEnd,
          lines: ["AAA"],
        },
      ]);
      throw new Error(
        "Expected applyHashlineEdits to throw for stale range anchor.",
      );
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toContain(
        `>>> ${validEnd.line}#${validEnd.hash}│eee`,
      );
    }
  });

  it("rejects overlapping replace ranges in one request", () => {
    const content = "aaa\nbbb\nccc\nddd";
    expect(() =>
      applyHashlineEdits(content, [
        {
          op: "replace",
          pos: makeTag(content, 2),
          end: makeTag(content, 3),
          lines: ["X"],
        },
        {
          op: "replace",
          pos: makeTag(content, 3),
          lines: ["Y"],
        },
      ]),
    ).toThrow(/conflicting edits.*overlap on the same original line range/i);
  });
});

describe("applyHashlineEdits — heuristics", () => {
  it("preserves trailing boundary-looking lines in replacements", () => {
    const content = "if (ok) {\n  run();\n}\nafter();";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 1),
        end: makeTag(content, 2),
        lines: ["if (ok) {", "  runSafe();", "}"],
      },
    ];
    const result = applyHashlineEdits(content, edits as any);
    expect(result.content).toBe("if (ok) {\n  runSafe();\n}\n}\nafter();");
    expect(result.warnings).toBeUndefined();
  });

  it("preserves leading boundary-looking lines in replacements", () => {
    const content = "before();\nif (ok) {\n  run();\n}\nafter();";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        end: makeTag(content, 3),
        lines: ["before();", "if (ok) {", "  runSafe();"],
      },
    ];
    const result = applyHashlineEdits(content, edits as any);
    expect(result.content).toBe(
      "before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();",
    );
    expect(result.warnings?.[0]).toContain(
      "[W_BOUNDARY_DUP] The replacement starts with a line that already exists on the preceding line",
    );
  });

  it("does not auto-correct escaped tab indentation even when the env flag is set", () => {
    const previous = process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
    process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = "1";

    try {
      const content = "root\n\tchild\n\t\tvalue\nend";
      const edits = [
        {
          op: "replace",
          pos: makeTag(content, 3),
          lines: ["\\t\\treplaced"],
        },
      ];
      const result = applyHashlineEdits(content, edits as any);

      expect(result.content).toBe("root\n\tchild\n\\t\\treplaced\nend");
      expect(result.warnings).toBeUndefined();
      expect(edits[0]).toEqual({
        op: "replace",
        pos: makeTag(content, 3),
        lines: ["\\t\\treplaced"],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
      } else {
        process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = previous;
      }
    }
  });

  it("warns on literal \\uDDDD without changing content", () => {
    const content = "aaa\nbbb\nccc";
    const edits = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        lines: ["\\uDDDD"],
      },
    ];
    const result = applyHashlineEdits(content, edits as any);

    expect(result.content).toBe("aaa\n\\uDDDD\nccc");
    expect(result.warnings?.[0]).toContain("contains literal \\uDDDD");
  });
});

describe("integration: resolveEditAnchors → applyHashlineEdits", () => {
  it("full pipeline: tool-schema edit → resolve → apply", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: ["BBB"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: string lines get parsed correctly", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: "BBB" },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: null lines → delete", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: null },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nccc");
  });

  it("full pipeline: hashline-prefixed string lines are auto-stripped", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const tag2 = `2#${computeLineHash(fileLines, 1)}│bbb`;
    const hash = computeLineHash(["BBB"], 0);
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: `2#${hash}│BBB` },
    ];
    // Prefix is auto-stripped — no throw
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: copied full-line anchor rejects fuzzy textHint when hash is arbitrary", () => {
    const line = 'he said "hi"';
    const content = `${line}\nkeep`;
    const actualHash = computeLineHash([line], 0);
    const arbitraryHash = actualHash === "XYZ" ? "_aB" : "XYZ";
    const staleWithHint = `1#${arbitraryHash}│${line}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: staleWithHint, lines: ["HELLO"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);

    expect(() => applyHashlineEdits(content, resolved)).toThrow(/stale anchor/);
  });

  it("full pipeline: copied diff-preview hunks are auto-stripped", () => {
    const content = "aaa\nbbb\nccc";
    const fileLines = content.split("\n");
    const start = `1#${computeLineHash(fileLines, 0)}`;
    const end = `3#${computeLineHash(fileLines, 2)}`;
    const replacement = [
      ` 1#${computeLineHash(fileLines, 0)}│aaa`,
      "-2    bbb",
      `+2#${computeLineHash(["BBB"], 0)}│BBB`,
      ` 3#${computeLineHash(fileLines, 2)}│ccc`,
    ].join("\n");
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: start, end, lines: replacement },
    ];
    // Prefixes are auto-stripped — no throw
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });
});
