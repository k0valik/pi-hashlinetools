import { describe, expect, it } from "vitest";
import {
  applyHashlineEdits,
  computeAffectedLineRange,
  computeLineHash,
  type HashlineEdit,
} from "../../src/hashline";

function makeTag(content: string, line: number) {
  const fileLines = content.split("\n");
  return { line, hash: computeLineHash(fileLines, line - 1) };
}

describe("applyHashlineEdits — basic operations", () => {
  it("returns content unchanged for empty edits", () => {
    const result = applyHashlineEdits("hello\nworld", []);
    expect(result.content).toBe("hello\nworld");
    expect(result.firstChangedLine).toBeUndefined();
  });

  it("replaces a single line", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 2), lines: ["BBB"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nccc");
    expect(result.firstChangedLine).toBe(2);
  });

  it("replaces a single line with multiple lines", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 2), lines: ["BBB", "B2"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nB2\nccc");
  });

  it("deletes a single line (empty lines array)", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 2), lines: [] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nccc");
  });

  it("replaces a range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        end: makeTag(content, 3),
        lines: ["BBB", "CCC"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
  });

  it("deletes a range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        end: makeTag(content, 3),
        lines: [],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nddd");
  });
});

describe("applyHashlineEdits — multi-edit ordering", () => {
  it("applies multiple edits bottom-up correctly", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 1), lines: ["AAA"] },
      { op: "replace", pos: makeTag(content, 3), lines: ["CCC"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("AAA\nbbb\nCCC");
  });

  it("deduplicates identical edits", () => {
    const content = "aaa\nbbb\nccc";
    const pos = makeTag(content, 2);
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("does not mutate caller-owned edit arrays while deduplicating", () => {
    const content = "aaa\nbbb\nccc";
    const pos = makeTag(content, 2);
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
    ];

    applyHashlineEdits(content, edits);

    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({
      op: "replace",
      pos: { ...pos },
      lines: ["BBB"],
    });
    expect(edits[1]).toEqual({
      op: "replace",
      pos: { ...pos },
      lines: ["BBB"],
    });
  });
});

describe("applyHashlineEdits — noop detection", () => {
  it("detects single-line noop", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 2), lines: ["bbb"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.noopEdits).toHaveLength(1);
    expect(result.noopEdits?.[0].editIndex).toBe(0);
  });

  it("detects range noop", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        end: makeTag(content, 3),
        lines: ["bbb", "ccc"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.noopEdits).toHaveLength(1);
  });
});

describe("applyHashlineEdits — warning heuristics", () => {
  it("warns on literal \\uDDDD without changing content", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        lines: ["\\uDDDD"],
      },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.content).toBe("aaa\n\\uDDDD\nccc");
    expect(result.warnings?.[0]).toContain("contains literal \\uDDDD");
  });
});

describe("applyHashlineEdits — lastChangedLine tracking", () => {
  it("tracks lastChangedLine when single-line replace expands to multiple lines", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        lines: ["B1", "B2", "B3", "B4", "B5"],
      },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(6);
  });

  it("tracks lastChangedLine correctly for single-line delete", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(content, 2), lines: [] },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(2);
  });

  it("tracks lastChangedLine correctly for multi-line delete", () => {
    const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(content, 2),
        end: makeTag(content, 4),
        lines: [],
      },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(4);
  });
});

describe("computeAffectedLineRange", () => {
  it("returns null when no lines changed", () => {
    expect(
      computeAffectedLineRange({
        firstChangedLine: undefined,
        lastChangedLine: undefined,
        resultLineCount: 10,
      }),
    ).toBeNull();
  });

  it("returns range with context for small changes", () => {
    const range = computeAffectedLineRange({
      firstChangedLine: 5,
      lastChangedLine: 5,
      resultLineCount: 10,
    });
    expect(range).toEqual({ start: 3, end: 7 });
  });

  it("returns null when range exceeds max output lines", () => {
    const range = computeAffectedLineRange({
      firstChangedLine: 1,
      lastChangedLine: 20,
      resultLineCount: 20,
    });
    expect(range).toBeNull();
  });
});

// Display prefix stripping moved to edit-payload-normalize.ts in .
// The old "applyHashlineEdits — display prefix stripping" describe
// block has been moved to test/core/edit-payload-normalize.test.ts
// (see `describe("validateAndFixLines", ...)`).
describe("applyHashlineEdits — display prefix stripping (deprecated)", () => {
  it("(test removed; stripping moved to normalization layer)", () => {
    // This test is a placeholder to keep the describe block valid
    // for now. Strip the entire block once we're confident the new
    // normalization tests cover all the cases.
    expect(true).toBe(true);
  });
});
