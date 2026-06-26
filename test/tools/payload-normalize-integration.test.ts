import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

describe("payload-normalize integration: end-to-end behavior", () => {
  it("strips LINE#ID│ display prefix in `lines` and writes raw content", async () => {
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3"];
        const ref2 = fullHashRef(lines, 2);

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [ref2, ref2],
                // Model accidentally pasted the read-output prefix.
                lines: ["2#Xy0│line2_new"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("line1\nline2_new\nline3\n");
        //  silent on success. The diff shows the change.
        const text = result.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/W_DISPLAY_PREFIX_IN_LINES/);
      },
    );
  });

  it("does NOT strip anchor echo for single-line replace (noop protection)", async () => {
    // `range: [a, a]` (single-line replace) with `lines: [a]` —
    // the model is replacing the line with the same content. This
    // is a noop, not a duplicate. We do NOT strip the leading
    // echo (that would delete the line). Matches the conservative
    // `length > 1` guard from pi-readseek.
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3"];
        const ref2 = fullHashRef(lines, 2);

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [ref2, ref2],
                lines: ["line2"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // File is unchanged
        expect(await readFile(path, "utf-8")).toBe("line1\nline2\nline3\n");
        // No W_ANCHOR_ECHO warning. (The regex is bracketed to exclude
        // the new W_ANCHOR_ECHO_STRIPPED reminder, which is fine.)
        const text = result.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/\[W_ANCHOR_ECHO\]/);
      },
    );
  });

  it("strips leading anchor echo for multi-line range replace (auto-fix duplicate)", async () => {
    // `range: [1, 3]` with `lines: [line1, new_content]`. The first
    // line of `lines` duplicates line 1 of the range. We strip the
    // echo so the range is replaced with just `new_content`.
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\nline4\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3", "line4"];
        const r1 = fullHashRef(lines, 1);
        const r3 = fullHashRef(lines, 3);

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [r1, r3],
                lines: ["line1", "new_content"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // line1 was the anchor of the range, so it gets removed;
        // the echo of line1 in lines[0] is stripped, leaving just
        // "new_content". Result: line1, line2, line3 are
        // replaced with new_content.
        expect(await readFile(path, "utf-8")).toBe("new_content\nline4\n");
        // P3 (modified): the auto-fix happens silently, but the model
        // gets a brief reminder. Verify the new reminder is present.
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/\[W_ANCHOR_ECHO_STRIPPED\].*leading/);
      },
    );
  });

  it("restores indent when lines[i] has zero leading whitespace", async () => {
    await withTempFile(
      "test.txt",
      "line1\n    indented\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "    indented", "line3"];
        const ref2 = fullHashRef(lines, 2);

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [ref2, ref2],
                // Zero-indent body under an indented block
                lines: ["new_content"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          "line1\n    new_content\nline3\n",
        );
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/W_INDENT_RESTORED/);
      },
    );
  });

  it("treats a single prefix-only line as 'replace with blank'", async () => {
    // The old contract: lines: ["2#Xy0│"] (prefix with nothing after)
    // was a stripping error → E_INVALID_PATCH.
    // The new contract: it's a valid "replace line 2 with a blank
    // line" edit. No error, file is updated.
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3"];
        const ref2 = fullHashRef(lines, 2);

        await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [ref2, ref2],
                // Prefix with nothing after → "replace with blank"
                lines: ["2#Xy0│"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // line2 replaced with a blank line.
        expect(await readFile(path, "utf-8")).toBe("line1\n\nline3\n");
      },
    );
  });

  it("throws E_INVALID_PATCH when lines is empty after stripping (diff-marker only)", async () => {
    // The emptyAfterStrip path is only triggered when stripping left
    // us with NO valid line at
    // all. A diff marker like "- 2    only line" is dropped entirely
    // (not user content) and trips the error.
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3"];
        const ref2 = fullHashRef(lines, 2);

        await expect(
          editTool.execute(
            "e1",
            {
              path: "test.txt",
              edits: [
                {
                  op: "replace",
                  range: [ref2, ref2],
                  // Diff marker — dropped entirely, not user content
                  lines: ["- 2    only line"],
                },
              ],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          ),
        ).rejects.toThrow(/E_INVALID_PATCH/);

        // File unchanged
        expect(await readFile(path, "utf-8")).toBe("line1\nline2\nline3\n");
      },
    );
  });

  it("converts wide-range-replace to prepend via broadRangeToInsert", async () => {
    // The plan's motivating example: model uses `range: [2, 5]`
    // with `lines: ["Note: this section..."]` when it meant
    // `op: "prepend"` on line 6.
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const fileLines = [
          "line1",
          "line2",
          "line3",
          "line4",
          "line5",
          "line6",
          "line7",
        ];
        const r2 = fullHashRef(fileLines, 2);
        const r5 = fullHashRef(fileLines, 5);

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [r2, r5],
                lines: ["Note: this section is interesting"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // The "Note: this section..." line is inserted at line 6
        // (the line after the original range end). Lines 2-5
        // are unchanged.
        expect(await readFile(path, "utf-8")).toBe(
          "line1\nline2\nline3\nline4\nline5\nNote: this section is interesting\nline6\nline7\n",
        );
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/W_RANGE_TOO_BROAD/);
      },
    );
  });

  it("does NOT convert wide-range-replace in multi-edit batches (preserves conflict detection)", async () => {
    // Two wide-range-replace edits in a batch — the original
    // ranges overlap, so the batch should be refused. We do NOT
    // apply broadRangeToInsert for multi-edit batches, so the
    // dry-run's conflict detection still fires.
    await withTempFile("test.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const fileLines = ["a", "b", "c", "d", "e"];
      const r1 = fullHashRef(fileLines, 1);
      const r3 = fullHashRef(fileLines, 3);
      const r2 = fullHashRef(fileLines, 2);
      const r4 = fullHashRef(fileLines, 4);

      const result = await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [
            { op: "replace", range: [r1, r3], lines: ["X"] },
            { op: "replace", range: [r2, r4], lines: ["Y"] },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      // The batch should be refused with E_EDIT_REFUSED, not
      // silently applied. The original overlapping replace
      // ranges are preserved (not converted to prepends).
      const text = result.content?.[0]?.text ?? "";
      expect(text).toMatch(/E_EDIT_REFUSED/);
      expect(text).toMatch(/overlapping lines/);
      // The conversion warning should NOT appear
      expect(text).not.toMatch(/W_RANGE_TOO_BROAD/);
      // File unchanged
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\n");
    });
  });

  it("emits a W_ANCHOR_ECHO_STRIPPED reminder for trailing anchor echo (P3 modified)", async () => {
    // Range: [1, 3] (lines 1-3). Lines: ['line1', 'new_content', 'line3'].
    // The trailing line "line3" matches the range end anchor. Stripped,
    // with a trailing-echo reminder.
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\nline4\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3", "line4"];
        const r1 = fullHashRef(lines, 1);
        const r3 = fullHashRef(lines, 3);

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              {
                op: "replace",
                range: [r1, r3],
                lines: ["line1", "new_content", "line3"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // Both leading AND trailing echo are stripped, so we should
        // see two reminders.
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/\[W_ANCHOR_ECHO_STRIPPED\].*leading/);
        expect(text).toMatch(/\[W_ANCHOR_ECHO_STRIPPED\].*trailing/);
      },
    );
  });
});
