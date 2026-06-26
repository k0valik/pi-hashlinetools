import { describe, expect, it } from "vitest";
import { tryDryRun } from "../../src/edit-dry-run";
import { computeLineHash, type HashlineToolEdit } from "../../src/hashline";

/** Build a valid hashline anchor with the correct hash for a line. */
function makeAnchor(fileLines: string[], lineNumber: number): string {
  const hash = computeLineHash(fileLines, lineNumber - 1);
  return `${lineNumber}#${hash}│${fileLines[lineNumber - 1] ?? ""}`;
}

describe("tryDryRun — happy path", () => {
  it("applies a single replace edit successfully", () => {
    const fileLines = ["aaa", "bbb", "ccc"];
    const fileContent = fileLines.join("\n");
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: makeAnchor(fileLines, 2), lines: ["BBB"] },
    ];
    // Stub the raw buffer as the same content
    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 3,
      edits,
      rawBuffer: Buffer.from(fileContent + "\n", "utf-8"),
    });
    expect(result.wouldBeNoop).toBe(false);
    expect(result.conflicts).toHaveLength(0);
    expect(result.perEdit).toHaveLength(1);
    expect(result.perEdit[0]?.outcome).toMatch(/applied|relocated/);
    expect(result.wouldApply).toBe("aaa\nBBB\nccc");
  });

  it("returns wouldBeNoop when no edits are provided", () => {
    const fileLines = ["aaa", "bbb"];
    const fileContent = fileLines.join("\n");
    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 2,
      edits: [],
      rawBuffer: Buffer.from(fileContent + "\n", "utf-8"),
    });
    expect(result.wouldBeNoop).toBe(true);
    expect(result.wouldApply).toBe(fileContent);
  });
});

describe("tryDryRun — per-edit evidence", () => {
  it("marks an edit as failed when the medley cannot find a match", () => {
    const fileLines = ["aaa", "bbb", "ccc"];
    const fileContent = fileLines.join("\n");
    // Use a line number that doesn't exist in the file to force a failure
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "99#XXX│DOES_NOT_EXIST", lines: ["X"] },
    ];
    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 3,
      edits,
      rawBuffer: Buffer.from(fileContent + "\n", "utf-8"),
    });
    // Anchor resolution throws E_LINE_OUT_OF_RANGE; dry-run catches it and marks all as failed
    expect(result.perEdit.some((e) => e.outcome === "failed")).toBe(true);
    expect(result.wouldBeNoop).toBe(true);
  });

  it("returns conflicts when two edits target the same line", () => {
    const fileLines = ["aaa", "bbb", "ccc"];
    const fileContent = fileLines.join("\n");
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: makeAnchor(fileLines, 2), lines: ["X"] },
      { op: "replace", pos: makeAnchor(fileLines, 2), lines: ["Y"] },
    ];
    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 3,
      edits,
      rawBuffer: Buffer.from(fileContent + "\n", "utf-8"),
    });
    // Conflict detection happens at the apply step. The dry-run captures
    // the E_EDIT_CONFLICT in `conflicts` (not per-edit evidence).
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.wouldBeNoop).toBe(true);
  });
});

describe("tryDryRun — multi-edit batch", () => {
  it("applies multiple independent edits in order", () => {
    const fileLines = ["aaa", "bbb", "ccc", "ddd"];
    const fileContent = fileLines.join("\n");
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: makeAnchor(fileLines, 1), lines: ["AAA"] },
      { op: "replace", pos: makeAnchor(fileLines, 3), lines: ["CCC"] },
    ];
    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 4,
      edits,
      rawBuffer: Buffer.from(fileContent + "\n", "utf-8"),
    });
    expect(result.wouldApply).toBe("AAA\nbbb\nCCC\nddd");
    expect(result.perEdit.every((e) => e.outcome !== "failed")).toBe(true);
  });
});
