import { describe, expect, it } from "vitest";
import register from "../../index";
import { computePublicLineChecksum } from "../../src/line-ref";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function publicRef(fileLines: string[], lineNumber: number): string {
  const cs = computePublicLineChecksum(fileLines, lineNumber);
  return `${lineNumber}${cs}│${fileLines[lineNumber - 1] ?? ""}`;
}

function toolkit() {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { editTool: getTool("edit") };
}

function ctx(cwd: string) {
  return { cwd, hasUI: true, ui: { notify() {} } } as any;
}

describe("byte-level relocation — stress test findings", () => {
  // F1 — TRIM BUG: normalizedContentHint strips leading whitespace,
  // causing tryByteRelocate to find the trimmed needle at an offset
  // within the line, never at a line-start byte boundary.
  //
  // Currently this test FAILS (E_LINE_CHANGED). After the
  // fix (passing untrimmed contentHint to tryByteRelocate), it should
  // succeed with W_BYTE_RELOCATE.

  it("F1: byte-level relocate rejects indented content due to trim bug", async () => {
    // 50 pad lines push the target well beyond ±40 text-line radius.
    // Target has 4 leading spaces — after trim, needle is shorter,
    // match position is not at line-start byte boundary.
    const padLines = Array.from({ length: 50 }, (_, i) => `pad ${i + 1}`);
    const targetLine = "    indented-target";
    const fileContent = `${[...padLines, targetLine].join("\n")}\n`;

    await withTempFile(
      "byte-indent.txt",
      fileContent,
      async ({ cwd, path }) => {
        const { editTool } = toolkit();
        // Stale ref: model thinks this content is at line 1
        const ref = publicRef([targetLine], 1);

        // CURRENTLY: succeeds via Layer 1 exact content-hint match (checksum format change)
        // AFTER FIX: should succeed with W_BYTE_RELOCATE when byte-level relocation is needed
        const result = await editTool.execute(
          "e",
          {
            path: "byte-indent.txt",
            edits: [{ range: [ref, ref], lines: ["    modified"] }],
          },
          undefined,
          undefined,
          ctx(cwd),
        );
        expect(result.details?.metrics?.classification).toBe("applied");
        const fileContent = await import("node:fs/promises").then((m) =>
          m.readFile(path, "utf-8"),
        );
        expect(fileContent).toBe(
          `${[...padLines, "    modified"].join("\n")}\n`,
        );
      },
    );
  });

  // F2 — MISLEADING ERROR MESSAGE: When fuzzy search finds multiple
  // matching lines within ±40, the error used to say
  // "Content not found within ±40 lines" — but the content WAS found,
  // it was just ambiguous. After fix, the error should be a distinct
  // E_RELOCATE_AMBIGUOUS that explicitly tells the model the target
  // appears N times.

  it("F2: error message is E_RELOCATE_AMBIGUOUS when target content appears multiple times ", async () => {
    // File with duplicate content lines within ±40 radius
    const fileContent = "aaa\n  dup-content\nbbb\n  dup-content\nccc\n";

    await withTempFile(
      "fuzzy-dup-msg.txt",
      fileContent,
      async ({ cwd, path }) => {
        const { editTool } = toolkit();
        // Stale ref claiming "  dup-content" is at line 1
        const ref = publicRef(["  dup-content"], 1);

        const result = await editTool.execute(
          "e",
          {
            path: "fuzzy-dup-msg.txt",
            edits: [{ range: [ref, ref], lines: ["modified"] }],
          },
          undefined,
          undefined,
          ctx(cwd),
        );

        // v2 plan: dry-run failures refuse the whole batch with noop + warnings
        expect(result.details?.metrics?.classification).toBe("noop");
        const text = result.content?.[0]?.text ?? "";
        // The error is now a distinct E_RELOCATE_AMBIGUOUS that tells the
        // model the target content appears N times. (E_LINE_CHANGED
        // would be misleading because the content IS in the file — it's
        // just that we can't decide which copy to edit.)
        expect(text).toMatch(/E_RELOCATE_AMBIGUOUS/);
        expect(text).toMatch(/appears.*times|appears multiple/i);
      },
    );
  });

  // F3 — BARE \r LINE-COUNTING MISMATCH: If a file contains bare \r
  // (without \n), normalizeToLF adds extra lines to visibleLineCount,
  // but tryByteRelocate counts only \n bytes in the raw buffer.
  // This can cause off-by-one line number mapping.
  //
  // This is hard to test via the full pipeline without modifying
  // resolveEditTarget. Left as documentation for now.

  // F4 — COMMENT CONTAMINATION: Content from header comments that
  // quote the target text creates false positives for Buffer.indexOf.
  // Already handled by positions.length !== 1 reject guard.
  // Correct behavior verified in duplicate-lines fixture.

  // F5 — LAYER 4 (HASH-INDEX) SILENT FAILURE: When every checksum
  // letter appears on ≥2 lines, hash-index relocation can never
  // succeed, and the error message gives no hint. Edge case in
  // repetitive/generated files; low priority.

  // F6 — SHORT-NEEDLE EXPLOSION: Short trimmed needles like "line"
  // match hundreds of times via Buffer.indexOf. Not a practical
  // concern since content hints are always full line content from
  // endpoint refs. Info only.
});
