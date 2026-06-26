import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  expectRefusedWithError,
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

describe("overlapping ranges produce a refused noop with [E_EDIT_REFUSED] and reason", () => {
  it("overlapping ranges produce a refused noop with [E_EDIT_REFUSED], not a silent noop", async () => {
    await withTempFile(
      "conflict.txt",
      "a\nb\nc\nd\ne\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["a", "b", "c", "d", "e"];
        // Two overlapping ranges
        const r1 = [fullHashRef(lines, 1), fullHashRef(lines, 3)];
        const r2 = [fullHashRef(lines, 2), fullHashRef(lines, 4)];

        const result = await editTool.execute(
          "e",
          {
            path: "conflict.txt",
            edits: [
              { op: "replace", range: r1, lines: ["X"] },
              { op: "replace", range: r2, lines: ["Y"] },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // Should be a refused noop, not a silent "identical content" noop.
        expectRefusedWithError(result, /\[E_EDIT_REFUSED\]/);
        expectRefusedWithError(result, /\[E_EDIT_CONFLICT\]/);

        // The text should mention the reason for the refusal (not just the
        // generic "identical content" framing). The user should see WHY
        // the batch was refused.
        // The user-facing reason text was cleaned up: "edits conflict
        // (E_EDIT_CONFLICT)" became "two edits in this batch target
        // overlapping lines — merge them into a single edit or split the
        // batch".
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/overlapping lines.*merge.*split/i);
      },
    );
  });

  it("E_EDIT_REFUSED message hints at `replace_text` as an alternative for whole-block rewrites (P1.2)", async () => {
    // The whole-block-rewrite hint steers the model toward `replace_text`
    // when it has two edits that try to replace the same region with
    // different content — a common failure mode where the model splits
    // a single logical change into two range edits.
    await withTempFile(
      "conflict.txt",
      "a\nb\nc\nd\ne\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["a", "b", "c", "d", "e"];
        const r1 = [fullHashRef(lines, 1), fullHashRef(lines, 3)];
        const r2 = [fullHashRef(lines, 2), fullHashRef(lines, 4)];

        const result = await editTool.execute(
          "e",
          {
            path: "conflict.txt",
            edits: [
              { op: "replace", range: r1, lines: ["X"] },
              { op: "replace", range: r2, lines: ["Y"] },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        const text = result.content?.[0]?.text ?? "";
        // The new hint should mention `replace_text` as a simpler
        // alternative. The exact wording can vary; the model only
        // needs the op name to appear in the conflict message.
        expect(text).toMatch(/replace_text/);
      },
    );
  });
});
