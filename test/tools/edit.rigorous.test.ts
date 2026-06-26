import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("edit tool orchestrator - Rigorous Integration", () => {
  it("does NOT trigger [W_POSSIBLE_INSERT_AS_REPLACE] warning (heuristic removed per )", async () => {
    //  the W_POSSIBLE_INSERT_AS_REPLACE heuristic is removed.
    // The broadRangeToInsert path is the sole handler for the
    // wide-range-replace case, and it emits W_RANGE_TOO_BROAD as a
    // single summary (not per-line).
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
                range: ["2bb│line 2", "2bb│line 2"], // single line range
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

  describe("Schema Regex Edge Cases", () => {
    it("supports various line ref formats", async () => {
      await withTempFile(
        "formats.txt",
        "line 1\nline 2\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");

          const formats = [
            "1aa│line 1", // standard 2-hex
            "1#aaa│line 1", // legacy 3-char
            "1aaa│line 1", // compact 3-char
            "1|line 1", // pipe separator
          ];

          for (const ref of formats) {
            const result = await editTool.execute(
              `e-${ref}`,
              {
                path: "formats.txt",
                edits: [
                  {
                    op: "replace",
                    range: [ref, ref],
                    lines: ["changed"],
                  },
                ],
              },
              undefined,
              undefined,
              { cwd } as any,
            );

            expect(result.content[0].text).not.toContain("E_INVALID_REQUEST");
            // Restore for next format
            await writeFile(path, "line 1\nline 2\n");
          }
        },
      );
    });
  });

  it("partial-applies the successful edit and reports the failed one ", async () => {
    //  when 1 of 2 edits fails, the successful one still applies.
    // The failed edit gets its per-edit error. The batch is NOT refused.
    await withTempFile(
      "refuse.txt",
      "line 1\nline 2\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        const result = await editTool.execute(
          "e1",
          {
            path: "refuse.txt",
            edits: [
              {
                op: "replace",
                range: ["1aa│line 1", "1aa│line 1"],
                lines: ["changed"],
              },
              {
                op: "replace",
                range: ["99#XXX│missing", "99#XXX│missing"],
                lines: ["fail"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        const text = result.content[0].text;
        // No E_EDIT_REFUSED — partial-apply.
        expect(text).not.toContain("[E_EDIT_REFUSED]");
        // No "X/Y applied cleanly" count.
        expect(text).not.toMatch(/\d+\/\d+ applied cleanly/);
        // The successful edit applied.
        const finalContent = await readFile(path, "utf-8");
        expect(finalContent).toContain("changed");
        // The failed edit is reported somewhere in the response.
        expect(text).toMatch(/99/);
      },
    );
  });
});
