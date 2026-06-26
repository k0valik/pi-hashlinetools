import { describe, expect, it } from "vitest";
import { registerEditTool } from "../../src/edit";
import { computePublicLineChecksum } from "../../src/line-ref";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

/**
 * Tests for the result-side render of the edit tool, exercising:
 *  - compact/expanded diff truncation in the result card
 *  - the "X insertions(+), Y deletion(-)" change summary line
 *  - section ordering (diff → change summary)
 *
 * The preview-side render (formatPreviewDiff) is already covered in
 * edit.preview.test.ts; this file focuses on the result path.
 */

const noopTheme = {
  bold: (text: string) => text,
  fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
};

function renderResultWithTheme(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editTool: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  expanded: boolean,
): string {
  // Note: the edit tool reads `context.expanded` (not the second-arg
  // `expanded`) to decide on compact/expanded truncation. Both must be
  // set to keep the render consistent with how the agent calls it.
  const component = editTool.renderResult(
    result,
    { expanded, isPartial: false },
    noopTheme,
    {
      args: { path: "x" },
      isError: false,
      lastComponent: undefined,
      expanded,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ) as { render: (width: number) => string[] };
  return component.render(200).join("\n");
}

function fullPublicRef(fileLines: string[], lineNumber: number): string {
  return `${lineNumber}${computePublicLineChecksum(fileLines, lineNumber)}│${fileLines[lineNumber - 1] ?? ""}`;
}

describe("edit result render", () => {
  it("truncates result diff to 16 lines in compact mode and shows ellipsis", async () => {
    // 30 lines, replace 20 of them to produce a diff with > 16 visible lines.
    // The first 16 lines of the diff are: 4 context + 12 removed (`-`).
    // All 20 insertions (`+`) are after the truncation point in compact mode.
    const lines = Array.from(
      { length: 30 },
      (_, i) => `line${String(i + 1).padStart(2, "0")}`,
    );
    const fileContent = `${lines.join("\n")}\n`;

    await withTempFile("big.txt", fileContent, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const startRef = fullPublicRef(lines, 5);
      const endRef = fullPublicRef(lines, 24);
      const replacement = Array.from(
        { length: 20 },
        (_, i) => `NEW${String(i + 1).padStart(2, "0")}`,
      );

      const result = await editTool.execute(
        "e1",
        {
          path: "big.txt",
          edits: [{ range: [startRef, endRef], lines: replacement }],
        },
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cwd } as any,
      );

      const compact = renderResultWithTheme(editTool, result, false);
      const expanded = renderResultWithTheme(editTool, result, true);

      // Compact: must contain the ellipsis marker
      expect(compact).toMatch(/more diff lines/);
      // Compact: must NOT contain any `+` insertion (all truncated out)
      expect(compact).not.toContain("NEW01");
      expect(compact).not.toContain("NEW20");
      // Compact: must still contain early context (the kept portion)
      expect(compact).toContain("line01");

      // Expanded: every replacement must be present, no ellipsis
      expect(expanded).toContain("NEW20");
      expect(expanded).not.toMatch(/more diff lines/);
    });
  });

  it("does not truncate a small diff in compact mode", async () => {
    await withTempFile("small.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const lines = ["aaa", "bbb", "ccc"];
      const ref = fullPublicRef(lines, 2);

      const result = await editTool.execute(
        "e1",
        { path: "small.txt", edits: [{ range: [ref, ref], lines: ["BBB"] }] },
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cwd } as any,
      );

      const rendered = renderResultWithTheme(editTool, result, false);
      expect(rendered).not.toMatch(/more diff lines/);
    });
  });

  it("emits change summary 'X insertions(+), Y deletion(-)' with singular grammar", async () => {
    await withTempFile("a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const lines = ["alpha", "beta", "gamma"];
      const ref = fullPublicRef(lines, 2);

      const result = await editTool.execute(
        "e1",
        { path: "a.txt", edits: [{ range: [ref, ref], lines: ["BETA"] }] },
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cwd } as any,
      );

      const rendered = renderResultWithTheme(editTool, result, true);
      // 1 insertion, 1 deletion — singular
      expect(rendered).toMatch(
        /\[accent\]1 insertion\(\+\), 1 deletion\(-\)\[\/accent\]/,
      );
    });
  });

  it("pluralizes insertions/deletions when count > 1", async () => {
    // 5-line file, replace 3 lines with 4 lines → 4 insertions, 3 deletions
    const lines = ["a", "b", "c", "d", "e"];
    const fileContent = `${lines.join("\n")}\n`;

    await withTempFile("a.txt", fileContent, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const startRef = fullPublicRef(lines, 2);
      const endRef = fullPublicRef(lines, 4);
      const replacement = ["X", "Y", "Z", "W"];

      const result = await editTool.execute(
        "e1",
        {
          path: "a.txt",
          edits: [{ range: [startRef, endRef], lines: replacement }],
        },
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cwd } as any,
      );

      const rendered = renderResultWithTheme(editTool, result, true);
      // Both plural
      expect(rendered).toMatch(
        /\[accent\]4 insertions\(\+\), 3 deletions\(-\)\[\/accent\]/,
      );
    });
  });

  it("does not render the change summary when the edit is a noop", async () => {
    // An edit that produces the same content goes through the noop path,
    // so isAppliedChangedResult is false and buildAppliedChangedResultText
    // is never called. Pin this: the rendered output must not contain
    // 'insertion' or 'deletion' tokens.
    await withTempFile("a.txt", "x\ny\nz\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const lines = ["x", "y", "z"];
      const ref = fullPublicRef(lines, 2);

      const result = await editTool.execute(
        "e1",
        { path: "a.txt", edits: [{ range: [ref, ref], lines: ["y"] }] }, // same content
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cwd } as any,
      );

      const rendered = renderResultWithTheme(editTool, result, true);
      expect(rendered).not.toContain("insertion");
      expect(rendered).not.toContain("deletion");
    });
  });

  it("places the change summary after the diff section", async () => {
    await withTempFile("a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const lines = ["alpha", "beta", "gamma"];
      const ref = fullPublicRef(lines, 2);

      const result = await editTool.execute(
        "e1",
        { path: "a.txt", edits: [{ range: [ref, ref], lines: ["BETA"] }] },
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cwd } as any,
      );

      const rendered = renderResultWithTheme(editTool, result, true);

      // Find the position of a diff line and the summary line.
      // Diff lines wrap as "[success]+LINEc│CONTENT[/success]" (or
      // [error] for `-` lines). Use "BETA" inside the success block as
      // a stable substring that appears in the diff but not the summary.
      const diffPos = rendered.indexOf("BETA");
      const summaryPos = rendered.indexOf("insertion(+)");
      expect(diffPos).toBeGreaterThan(-1);
      expect(summaryPos).toBeGreaterThan(-1);
      expect(summaryPos).toBeGreaterThan(diffPos);
    });
  });
});
