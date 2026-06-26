/**
 *  ( plan): partial-apply per edit in a multi-edit batch.
 * When 1 edit fails and 2 succeed, the 2 successful edits apply and
 * the 1 failed edit emits its per-edit error code. The whole batch
 * is NOT refused with `E_EDIT_REFUSED` and the misleading
 * "X/Y applied cleanly" count is gone.
 *
 * User's principle: "If we have the technology to fix it, we fix it.
 * The dry-run is the safety mechanism."
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("multi-edit partial-apply ", () => {
  it("applies the successful edits and emits per-edit error for the failed one", async () => {
    await withTempFile(
      "partial.txt",
      "line 1\nline 2\nline 3\nline 4\nline 5\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        const lines = ["line 1", "line 2", "line 3", "line 4", "line 5"];

        const result = await editTool.execute(
          "e1",
          {
            path: "partial.txt",
            edits: [
              // Edit 0: applies (line 1 → "CHANGED 1")
              {
                op: "replace",
                range: [fullHashRef(lines, 1), fullHashRef(lines, 1)],
                lines: ["CHANGED 1"],
              },
              // Edit 1: fails (line 99 doesn't exist)
              {
                op: "replace",
                range: ["99#XXX│missing", "99#XXX│missing"],
                lines: ["fail"],
              },
              // Edit 2: applies (line 3 → "CHANGED 3")
              {
                op: "replace",
                range: [fullHashRef(lines, 3), fullHashRef(lines, 3)],
                lines: ["CHANGED 3"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        const text = getText(result);

        // The 2 successful edits applied; the file is partially
        // updated. (We don't insist on "noop" or "applied" globally
        // — the metric is per-edit.)
        const finalContent = await readFile(path, "utf-8");
        expect(finalContent).toContain("CHANGED 1");
        expect(finalContent).toContain("CHANGED 3");
        // Line 2, 4, 5 unchanged
        expect(finalContent).toContain("line 2");
        expect(finalContent).toContain("line 4");
        expect(finalContent).toContain("line 5");

        // No E_EDIT_REFUSED — the batch is not refused wholesale.
        expect(text).not.toContain("[E_EDIT_REFUSED]");
        // No "X/Y applied cleanly" count.
        expect(text).not.toMatch(/\d+\/\d+ applied cleanly/);
        // The failed edit's per-edit error IS present.
        expect(text).toMatch(/99/); // anchor number is mentioned
      },
    );
  });

  it("applies all edits when none fail (no false refused)", async () => {
    // Sanity check: the new partial-apply logic doesn't accidentally
    // refuse the batch when nothing is wrong.
    await withTempFile(
      "all-good.txt",
      "line 1\nline 2\nline 3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        const lines = ["line 1", "line 2", "line 3"];

        const result = await editTool.execute(
          "e1",
          {
            path: "all-good.txt",
            edits: [
              {
                op: "replace",
                range: [fullHashRef(lines, 1), fullHashRef(lines, 1)],
                lines: ["A"],
              },
              {
                op: "replace",
                range: [fullHashRef(lines, 3), fullHashRef(lines, 3)],
                lines: ["C"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        const finalContent = await readFile(path, "utf-8");
        expect(finalContent).toBe("A\nline 2\nC\n");

        const text = getText(result);
        expect(text).not.toContain("[E_EDIT_REFUSED]");
        expect(text).not.toMatch(/\d+\/\d+ applied cleanly/);
      },
    );
  });

  it("partial-apply: valid-subset dry-run warnings are merged into output", async () => {
    // re-dry-run for the partial-apply path, the new dryRun.warnings
    // (relocation, hash relocate, stale context for the applied edits)
    // were never pushed to the shared `warnings` array. The model
    // never got the brief reminder that a silent fix had occurred.
    //
    // We construct a scenario where the valid edit needs a relocation
    // warning (stale ref + far-away target) and the invalid edit uses
    // a non-existent line. The relocation reminder must appear in
    // the output text for the model to see.
    const padLines = Array.from({ length: 50 }, (_, i) => `pad ${i + 1}`);
    const targetLine = "unique-target-content";
    const fileContent = `${[...padLines, targetLine].join("\n")}\n`;

    await withTempFile("partial-warnings.txt", fileContent, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      // Stale ref for the valid edit (forces byte-level relocation,
      // which emits W_BYTE_RELOCATE). The fake checksum "xyz" is a
      // valid 3-char base64 form but is not the checksum of any line
      // in the file, so Layer 4 (hash-index) will not match.
      const staleRef = `1xyz│${targetLine}`;

      const result = await editTool.execute(
        "e1",
        {
          path: "partial-warnings.txt",
          edits: [
            // Edit 0: valid, but needs byte-level relocation.
            {
              op: "replace",
              range: [staleRef, staleRef],
              lines: ["modified"],
            },
            // Edit 1: invalid (line 99 doesn't exist).
            {
              op: "replace",
              range: ["99#XXX│missing", "99#XXX│missing"],
              lines: ["fail"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      const text = getText(result);

      // No wholesale refused.
      expect(text).not.toContain("[E_EDIT_REFUSED]");

      // Critical: the W_BYTE_RELOCATE reminder from the
      // valid-subset dry-run MUST appear in the output. Before
      // the fix, `dryRun = runDryRun(partition.valid)` reassigned
      // dryRun but never merged dryRun.warnings into the shared
      // `warnings` array, so the model saw no reminder for the
      // silent relocation.
      expect(text).toContain("[W_BYTE_RELOCATE]");
    });
  });
});
