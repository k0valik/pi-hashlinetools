/**
 *  ( plan): drop the `W_POSSIBLE_INSERT_AS_REPLACE`
 * heuristic at edit.ts:1093-1110. The `broadRangeToInsert` path
 * in `edit-payload-normalize.ts` is the sole handler for the
 * "wide-range replace that should be a prepend" case, and it
 * already emits `W_RANGE_TOO_BROAD` as a single summary.
 *
 * The user's principle: "if we have the technology to fix it, we
 * fix it." The duplicate warning is noise.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

describe("wide-range single-line-to-multi-line edit ", () => {
  it("does NOT emit W_POSSIBLE_INSERT_AS_REPLACE (heuristic removed)", async () => {
    await withTempFile(
      "heuristic.txt",
      "line 1\nline 2\nline 3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        const result = await editTool.execute(
          "e1",
          {
            path: "heuristic.txt",
            edits: [
              {
                op: "replace",
                range: [
                  fullHashRef(["line 1", "line 2", "line 3"], 2),
                  fullHashRef(["line 1", "line 2", "line 3"], 2),
                ], // single-line range
                lines: ["new line 2.1", "new line 2.2", "new line 2.3"], // multiple lines
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        const text = result.content[0].text;
        expect(text).not.toContain("[W_POSSIBLE_INSERT_AS_REPLACE]");
      },
    );
  });

  it("emits W_RANGE_TOO_BROAD as the single summary (broadRangeToInsert path)", async () => {
    // The auto-fix path stays. The wide-range-to-prepend conversion
    // is still useful — only the duplicate warning is removed.
    // broadRangeToInsert triggers on: multi-line range + lines.length===1
    // + low token overlap with the range content + range doesn't
    // extend to the last line (so there's somewhere to prepend).
    await withTempFile(
      "range-too-broad.txt",
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        const fileLines = ["alpha", "beta", "gamma", "delta", "epsilon"];

        const result = await editTool.execute(
          "e1",
          {
            path: "range-too-broad.txt",
            edits: [
              {
                op: "replace",
                range: [fullHashRef(fileLines, 1), fullHashRef(fileLines, 4)], // multi-line range, leaves last line as anchor
                lines: ["collapsed"], // single line, no token overlap → broadRangeToInsert
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        // The edit should still apply (broadRangeToInsert converts
        // to a prepend and commits).
        const finalContent = await readFile(path, "utf-8");
        expect(finalContent).toContain("collapsed");

        // W_RANGE_TOO_BROAD is the only wide-range warning the model
        // sees — no duplicate W_POSSIBLE_INSERT_AS_REPLACE.
        const text = result.content[0].text;
        expect(text).not.toContain("[W_POSSIBLE_INSERT_AS_REPLACE]");
      },
    );
  });
});
