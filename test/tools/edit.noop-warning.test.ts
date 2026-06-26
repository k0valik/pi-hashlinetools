import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  expectRefusedWithError,
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const bRef = fullHashRef(["aaa", "bbb", "ccc"], 2);

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                range: [bRef, bRef],
                lines: ["bbb"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        // "Classification: noop" used to appear in the user-facing text
        // but leaked the internal classification metric. The internal
        // classification still lives in `details.classification` for
        // tooling; the user-facing text just says "No changes made to
        // {path}".
        expect(getText(result)).toMatch(/No changes made to/);
        expect(getText(result)).toMatch(/the new content matches/);
        expect(result.details?.classification).toBe("noop");
        expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
      },
    );
  });

  it("emits a boundary duplication warning without blocking the edit", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const bRef = fullHashRef(["aaa", "bbb", "ccc"], 2);

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                range: [bRef, bRef],
                lines: ["BBB", "ccc"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(getText(result)).toContain("Warnings:");
        expect(getText(result)).toMatch(/boundary duplication|duplicate/i);
        expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\nccc\n");
      },
    );
  });
});
