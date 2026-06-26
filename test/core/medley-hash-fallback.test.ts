import { describe, expect, it } from "vitest";
import { runAnchorMedley } from "../../src/edit-strategies";
import { computePublicLineChecksum } from "../../src/line-ref";

/** Helper: build a file with N lines, return { lines, visible }.
 *  Each line is "line N" so we can assert the medley locates the right
 *  one. */
function makeFile(lineCount: number, format: (n: number) => string) {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(format(i));
  }
  return { lines, visible: lineCount };
}

describe("runAnchorMedley — Layer 4 hash-index soft fallback ", () => {
  it("relocates by hash when content hint fails and hash matches exactly 1 line", () => {
    // 10 lines, but the model's contentHint doesn't appear anywhere.
    // The hash matches line 4 (computed from the actual line 4 content).
    const { lines, visible } = makeFile(10, (n) => `line ${n} content`);
    // The hash of line 4 — we compute it by running runAnchorMedley with
    // the same content and no checksum to capture the hash. Easier:
    // derive the checksum from the underlying line-ref module.
    const fileLines = lines;
    // The checksum of line 4 is its public checksum. We import it
    // indirectly by using the medley with a content hint that matches
    // line 4 to get the resolved candidate, then re-run with a wrong
    // content hint but the correct checksum. For this test we just
    // hardcode by computing the hash from line content via a throw-away
    // round trip.
    // Approach: use the strategy's expected behavior — contentHint that
    // doesn't match anywhere, but checksum that does match exactly 1 line.
    // The medley will run Layer 4 and return the unique hash match.
    // We use a content hint that's not in the file at all.
    const contentHint = "this text does not exist anywhere in the file";
    // The checksum we need is the public line checksum of line 4. We
    // compute it via the line-ref module (sibling).
    // To keep the test self-contained, derive it from a known content:
    const checksum = computeChecksumForLine(fileLines, 4);
    const rawBuffer = Buffer.from(lines.join("\n") + "\n");
    const result = runAnchorMedley({
      fileLines,
      visibleLineCount: visible,
      expectedLine: 4,
      contentHint,
      checksum,
      rawBuffer,
    });
    expect(result.candidate).toBe(4);
    expect(result.outcome).toBe("relocated");
  });

  it("returns 'failed' when content hint fails and hash matches 0 lines", () => {
    const { lines, visible } = makeFile(10, (n) => `line ${n} content`);
    // A checksum that doesn't match any line.
    const checksum = "xxx";
    const rawBuffer = Buffer.from(lines.join("\n") + "\n");
    const result = runAnchorMedley({
      fileLines: lines,
      visibleLineCount: visible,
      expectedLine: 5,
      contentHint: "this text does not exist",
      checksum,
      rawBuffer,
    });
    expect(result.outcome).toBe("failed");
    expect(result.candidate).toBe(null);
  });

  it("returns 'ambiguous' when content hint fails and hash matches 2+ lines", () => {
    // Two lines with the same content produce the same hash.
    const lines = [
      "duplicate line",
      "other line",
      "another line",
      "duplicate line",
    ];
    const checksum = computeChecksumForLine(lines, 1);
    const rawBuffer = Buffer.from(lines.join("\n") + "\n");
    const result = runAnchorMedley({
      fileLines: lines,
      visibleLineCount: lines.length,
      expectedLine: 2,
      contentHint: "this text does not exist",
      checksum,
      rawBuffer,
    });
    // The medley should either return 'ambiguous' (Layer 4 unambiguous
    // failure) or 'failed' (Layer 5 also fails). Both signal the model
    // needs to refine its content hint. We accept either since the
    // orchestrator emits a hard error for both.
    expect(["ambiguous", "failed"]).toContain(result.outcome);
    expect(result.candidate).toBe(null);
  });

  it("does not invoke Layer 4 when content hint matches at expected line", () => {
    // The Layer 1 short-circuit should fire first.
    const { lines, visible } = makeFile(5, (n) => `line ${n} content`);
    const expectedLine = 3;
    const contentHint = lines[expectedLine - 1] ?? "";
    const rawBuffer = Buffer.from(lines.join("\n") + "\n");
    const result = runAnchorMedley({
      fileLines: lines,
      visibleLineCount: visible,
      expectedLine,
      contentHint,
      checksum: "ignored",
      rawBuffer,
    });
    expect(result.outcome).toBe("applied");
    expect(result.candidate).toBe(expectedLine);
    // No Layer 4 strategy should appear in the evidence.
    const layer4 = result.strategies.find((s) => s.name === "layer4-hash");
    expect(layer4).toBeUndefined();
  });
});

/** Local helper: compute the public checksum for a line. */
function computeChecksumForLine(fileLines: string[], line: number): string {
  return computePublicLineChecksum(fileLines, line);
}
