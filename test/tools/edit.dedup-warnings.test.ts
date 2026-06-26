/**
 * Warning dedup: when the same warning can be emitted from multiple
 * code paths, it must appear in the user-facing text exactly once.
 *
 * P0.1 (2026-06-24): a single E_ASYMMETRIC_SHIFT was rendered twice
 * because the `else if (partition.errors.length > 0)` branch in
 * `edit.ts` lacked the dedup that the partial-apply branch has.
 *
 * P0.2 (2026-06-24): for single-line ranges, both `pos` and `end` are
 * resolved independently by `anchorPublicLineRef` and both can emit
 * W_BYTE_RELOCATE for the same line, producing two identical warning
 * lines in the output.
 */
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registerEditTool } from "../../src/edit";
import {
  buildChangedResponse,
  buildNoopResponse,
} from "../../src/edit-response";
import { computePublicLineChecksum } from "../../src/line-ref";
import {
  expectRefusedWithError,
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

/** Count non-overlapping occurrences of a needle in a string. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) return count;
    count++;
    pos = i + needle.length;
  }
}

describe("warning dedup: E_ASYMMETRIC_SHIFT must appear once, not twice", () => {
  it("single edit with asymmetric shift: exactly one [E_ASYMMETRIC_SHIFT] in output", async () => {
    await withTempFile("test.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["a", "b", "c", "d", "e"];
      const refB = fullHashRef(lines, 2);
      const refD = fullHashRef(lines, 4);

      // Break the structure between b and d (insert 1 line at top of range).
      // The start ref (b) still matches at line 2 (0 shift).
      // The end ref (d) is now at line 5 (+1 shift).
      // Asymmetric → E_ASYMMETRIC_SHIFT.
      await writeFile(path, "a\nb\nINSERTED\nc\nd\ne\n");

      const result = await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ range: [refB, refD], lines: ["B", "C", "D"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expectRefusedWithError(result, /\[E_ASYMMETRIC_SHIFT\]/);

      // Critical assertion: the error string appears EXACTLY ONCE.
      // Before the dedup fix, the dry-run and partition both surfaced
      // the same error, and the `else if` branch pushed partition.errors
      // into `warnings[]` without dedup → 2 copies in the output.
      const text = getText(result);
      const count = countOccurrences(text, "[E_ASYMMETRIC_SHIFT]");
      expect(count).toBe(1);
    });
  });
});

describe("warning dedup: W_BYTE_RELOCATE for single-line ranges", () => {
  it("single-line range byte relocate: exactly one W_BYTE_RELOCATE for the start line", async () => {
    // 50 pad lines push the target beyond the ±40 fuzzy radius. We
    // construct a ref with a unique content hint and a fake checksum
    // that is NOT in the file — this forces Layer 4 (hash-index) to
    // fail and Layer 5 (byte-level) to succeed, emitting W_BYTE_RELOCATE.
    const padLines = Array.from({ length: 50 }, (_, i) => `pad ${i + 1}`);
    const targetLine = "unique-target-content";
    const fileContent = `${[...padLines, targetLine].join("\n")}\n`;

    await withTempFile(
      "byte-single-line.txt",
      fileContent,
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        // Stale ref: model thinks the target is at line 1. The fake
        // checksum "xyz" is a valid 3-char base64 form but is not the
        // checksum of any line in the file, so Layer 4 (hash-index) will
        // not match.
        const ref = `1xyz│${targetLine}`;

        const result = await editTool.execute(
          "e1",
          {
            path: "byte-single-line.txt",
            edits: [{ range: [ref, ref], lines: ["modified"] }],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // The edit should succeed (Layer 5 byte-level relocation).
        expect(result.details?.metrics?.classification).toBe("applied");

        // Critical: W_BYTE_RELOCATE must appear EXACTLY ONCE for the
        // start line. Before the fix, the range end was also resolved
        // through `anchorPublicLineRef`, which emitted a duplicate
        // W_BYTE_RELOCATE for the same line.
        const text = getText(result);
        const count = countOccurrences(text, "[W_BYTE_RELOCATE]");
        expect(count).toBe(1);
      },
    );
  });
});

describe("warning dedup: warningsBlockOf aggregates identical warnings (P2.2 defense in depth)", () => {
  // P2.2: defense in depth. The P0.1 and P0.2 fixes already dedup at
  // the source. This test verifies the FINAL RENDERER (warningsBlockOf
  // inside buildChangedResponse / buildNoopResponse) collapses
  // duplicates to a single line with a (×N) suffix. If any future code
  // path reintroduces a duplicate warning, the user still sees a clean
  // output.
  //
  // We test through the public builders rather than calling
  // warningsBlockOf directly (it's not exported) — that way we verify
  // the end-to-end rendering, not just the helper.

  const SAMPLE_WARNING = "[W_TEST] edit 0: a sample warning";

  it("buildNoopResponse collapses duplicate warnings to a single line with (×N) suffix", () => {
    const result = buildNoopResponse({
      path: "test.txt",
      noopEdits: [],
      originalNormalized: "a\nb\nc\n",
      snapshotId: "snap-1",
      editsAttempted: 1,
      warnings: [SAMPLE_WARNING, SAMPLE_WARNING, SAMPLE_WARNING],
    });

    const text = getText(result);
    // Exactly one occurrence of the warning text in the output.
    const count = countOccurrences(text, SAMPLE_WARNING);
    expect(count).toBe(1);
    // The (×3) suffix appears, signalling the count.
    expect(text).toMatch(/\(×3\)/);
  });

  it("buildChangedResponse collapses duplicate warnings with (×N) suffix", () => {
    const result = buildChangedResponse({
      path: "test.txt",
      originalNormalized: "a\nb\nc\n",
      result: "a\nB\nc\n",
      snapshotId: "snap-1",
      editsAttempted: 1,
      noopEditsCount: 0,
      warnings: [SAMPLE_WARNING, SAMPLE_WARNING],
    });

    const text = getText(result);
    const count = countOccurrences(text, SAMPLE_WARNING);
    expect(count).toBe(1);
    expect(text).toMatch(/\(×2\)/);
  });

  it("does NOT add (×N) suffix to a single (non-duplicate) warning", () => {
    const result = buildNoopResponse({
      path: "test.txt",
      noopEdits: [],
      originalNormalized: "a\nb\nc\n",
      snapshotId: "snap-1",
      editsAttempted: 1,
      warnings: [SAMPLE_WARNING],
    });

    const text = getText(result);
    expect(text).toContain(SAMPLE_WARNING);
    // No (×1) suffix — the renderer should not annotate singletons.
    expect(text).not.toMatch(/\(×1\)/);
  });

  it("keeps DIFFERENT warnings separate, even when they share a code prefix", () => {
    // Two warnings with the same code prefix but different content
    // are NOT duplicates. They should both appear, neither with (×N).
    const w1 = "[W_TEST] edit 0: first warning";
    const w2 = "[W_TEST] edit 1: second warning";
    const result = buildNoopResponse({
      path: "test.txt",
      noopEdits: [],
      originalNormalized: "a\nb\nc\n",
      snapshotId: "snap-1",
      editsAttempted: 2,
      warnings: [w1, w2],
    });

    const text = getText(result);
    expect(text).toContain(w1);
    expect(text).toContain(w2);
    expect(text).not.toMatch(/\(×/);
  });
});
