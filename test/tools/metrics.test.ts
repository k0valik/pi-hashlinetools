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

describe("details.metrics surface (Phase 2 C — host-only observability)", () => {
  it("read exposes truncation + next_offset metrics, never in text", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    await withTempFile("big.txt", `${lines}\n`, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "big.txt", limit: 50 },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.details?.metrics).toEqual({
        truncated: expect.any(Boolean),
        ...(result.details?.nextOffset !== undefined
          ? { next_offset: result.details.nextOffset }
          : {}),
      });
      expect(getText(result)).not.toContain("metrics");
    });
  });

  it("changed-mode edit reports applied classification + edits_attempted", async () => {
    await withTempFile("a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const bRef = fullHashRef(["alpha", "beta", "gamma"], 2);

      const result = await editTool.execute(
        "e1",
        {
          path: "a.txt",
          edits: [
            {
              range: [bRef, bRef],
              lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 0,
        warnings: 0,
        classification: "applied",
        added_lines: 1,
        removed_lines: 1,
      });
    });
  });

  it("noop edit reports classification noop and edits_noop count", async () => {
    await withTempFile("b.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const bRef = fullHashRef(["alpha", "beta"], 2);

      const result = await editTool.execute(
        "e1",
        {
          path: "b.txt",
          edits: [
            {
              range: [bRef, bRef],
              lines: ["beta"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 1,
        classification: "noop",
      });
      expect(result.details?.metrics?.changed_lines).toBeUndefined();
    });
  });

  it("metrics field never appears in user-visible text", async () => {
    await withTempFile("e.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const bRef = fullHashRef(["alpha", "beta"], 2);

      const result = await editTool.execute(
        "e1",
        {
          path: "e.txt",
          edits: [
            {
              range: [bRef, bRef],
              lines: ["beta"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).not.toMatch(/metrics|edits_attempted|edits_noop/);
    });
  });
});
