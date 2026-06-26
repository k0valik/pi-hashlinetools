import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { tryDryRun } from "../../src/edit-dry-run";
import { computeLineHash, type HashlineToolEdit } from "../../src/hashline";

describe("tryDryRun - Rigorous Testing", () => {
  const fileLines = ["line 1", "line 2", "line 3", "line 4", "line 5"];
  const fileContent = `${fileLines.join("\n")}\n`;
  const rawBuffer = Buffer.from(fileContent, "utf-8");

  function makeAnchor(line: number): string {
    const hash = computeLineHash(fileLines, line - 1);
    return `${line}#${hash}│${fileLines[line - 1]}`;
  }

  it("handles multi-edit batches with mixed outcomes", () => {
    const edits: HashlineToolEdit[] = [
      {
        op: "replace",
        pos: makeAnchor(1),
        lines: ["changed 1"],
      },
      {
        op: "replace",
        pos: "99#XXX│missing", // Will fail
        lines: ["wont happen"],
      },
    ];

    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 5,
      edits,
      rawBuffer,
    });

    expect(result.perEdit).toHaveLength(2);
    // Even if one fails, we want to see the result of others if possible?
    // Actually, anchorBareLineNumberEdits throws, so perEdit might all be "failed"
    // based on how tryDryRun is implemented (it catches the batch failure).
    expect(result.perEdit.some((e) => e.outcome === "failed")).toBe(true);
    expect(result.wouldBeNoop).toBe(true);
    expect(result.warnings.some((w) => w.includes("E_LINE_OUT_OF_RANGE"))).toBe(
      true,
    );
  });

  it("detects overlapping range conflicts (E_EDIT_CONFLICT)", () => {
    const edits: HashlineToolEdit[] = [
      {
        op: "replace",
        pos: makeAnchor(2),
        end: makeAnchor(4),
        lines: ["span 1"],
      },
      {
        op: "replace",
        pos: makeAnchor(3),
        lines: ["conflict"],
      },
    ];

    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 5,
      edits,
      rawBuffer,
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.reason).toContain("E_EDIT_CONFLICT");
    expect(result.wouldBeNoop).toBe(true);
  });

  it("identifies no-op edits", () => {
    const edits: HashlineToolEdit[] = [
      {
        op: "replace",
        pos: makeAnchor(2),
        lines: ["line 2"], // Identical to current content
      },
    ];

    const result = tryDryRun({
      fileContent,
      fileLines,
      visibleLineCount: 5,
      edits,
      rawBuffer,
    });

    expect(result.wouldBeNoop).toBe(true);
    expect(result.noopEdits).toHaveLength(1);
    expect(result.noopEdits[0]?.currentContent).toBe("line 2");
  });

  it("includes warnings from anchor resolution", () => {
    const staleFileLines = [...fileLines];
    staleFileLines[1] = "line 2 modified"; // moved to line 2, but anchor says line 2 (stale)

    const _edits: HashlineToolEdit[] = [
      {
        op: "replace",
        pos: "2#XYZ│line 2", // content hint "line 2" is now at line ? (not 2)
        lines: ["changed"],
      },
    ];
    // We need to set up a situation where relocation happens
    const movedLines = ["inserted", "line 1", "line 2", "line 3"];
    const movedContent = `${movedLines.join("\n")}\n`;
    const movedBuffer = Buffer.from(movedContent, "utf-8");

    const result = tryDryRun({
      fileContent: movedContent,
      fileLines: movedLines,
      visibleLineCount: 4,
      edits: [
        {
          op: "replace",
          pos: "2#XYZ│line 2", // in movedLines, "line 2" is at line 3. original ref said 2.
          lines: ["changed"],
        },
      ],
      rawBuffer: movedBuffer,
    });

    // User-facing text was cleaned up: "automatic relocation applied"
    // became "the edit is being applied to the new position".
    expect(
      result.warnings.some((w) =>
        w.includes("edit is being applied to the new position"),
      ),
    ).toBe(true);
    expect(result.wouldApply).toContain("changed");
  });
});
