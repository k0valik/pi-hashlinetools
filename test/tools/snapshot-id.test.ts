import { readFile, writeFile } from "node:fs/promises";
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

describe("snapshotId surface (details-only after W2)", () => {
  it("read writes snapshotId to details but not to text", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(getText(result)).not.toContain("snapshotId");
      expect(getText(result)).not.toContain("SnapshotId");
      expect(result.details?.snapshotId).toEqual(expect.any(String));
    });
  });

  it("edit silently ignores unknown root fields (AJV responsibility)", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const bRef = fullHashRef(["alpha", "beta"], 2);

      await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          snapshotId: "v1|fake|0|0",
          edits: [{ range: [bRef, bRef], lines: ["BETA"] }],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\n");
    });
  });

  it("edit succeeds even when the file changed on disk between read and edit, as long as anchors still match", async () => {
    await withTempFile(
      "sample.txt",
      "one\ntwo\nthree\nfour\nfive\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const fRef = fullHashRef(["one", "two", "three", "four", "five"], 4);

        // External, unrelated change: line 2 mutated, line 4 still "four".
        await writeFile(path, "one\nTWO!\nthree\nfour\nfive\n", "utf-8");

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                range: [fRef, fRef],
                lines: ["FOUR"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(getText(result)).toMatch(/ 2[A-Za-z0-9_\\-]{3}│/); // diff shows context line 2
        expect(getText(result)).toMatch(/\+4[A-Za-z0-9_\\-]{3}│/); // diff shows added line 4
        expect(await readFile(path, "utf-8")).toBe(
          "one\nTWO!\nthree\nFOUR\nfive\n",
        );
      },
    );
  });

  it("edit text response no longer contains a SnapshotId line", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const bRef = fullHashRef(["alpha", "beta"], 2);

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
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

      expect(getText(result)).not.toContain("SnapshotId");
      // details still expose the post-edit fingerprint for host UIs.
      expect(result.details?.snapshotId).toEqual(expect.any(String));
    });
  });

  it("a stale anchor triggers content mismatch error with unified format", async () => {
    await withTempFile(
      "sample.txt",
      "one\ntwo\nthree\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        // External change: rewrite the line we are about to target.
        await writeFile(path, "one\nTWO!\nthree\n", "utf-8");

        // v2 plan: dry-run refuses the batch with a noop response containing
        // per-edit evidence warnings. The error code is in the noop text.
        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                range: [
                  fullHashRef(["one", "two", "three"], 2),
                  fullHashRef(["one", "two", "three"], 2),
                ],
                lines: ["TWO"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );
        expectRefusedWithError(result, /\[E_LINE_CHANGED\]/);
        // User-facing text was cleaned up: "content does not match
        // current line 2" became "line 2 content has changed since you
        // read it".
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/line 2 content has changed/);
        expect(text).toContain('Expected: "two"');
        expect(text).toContain('actual: "TWO!"');
      },
    );
  });

  it("de-duplicates identical stale anchors in single-line range [X, X]", async () => {
    await withTempFile(
      "sample.txt",
      "one\ntwo\nthree\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        await writeFile(path, "one\nTWO!\nthree\n", "utf-8");

        // v2 plan: dry-run refuses the batch with a noop response containing
        // per-edit evidence warnings.
        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                range: [
                  fullHashRef(["one", "two", "three"], 2),
                  fullHashRef(["one", "two", "three"], 2),
                ],
                lines: ["TWO"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );
        // With unified format, the error is [E_LINE_CHANGED] from
        // anchorPublicLineRef, not [E_STALE_ANCHOR] from resolveEditAnchors.
        // Both anchors are identical so the message mentions a single mismatch.
        expectRefusedWithError(result, /\[E_LINE_CHANGED\]/);
        // User-facing text was cleaned up: "content does not match
        // current line 2" became "line 2 content has changed since you
        // read it".
        const text = result.content?.[0]?.text ?? "";
        expect(text).toMatch(/line 2 content has changed/);
      },
    );
  });
});
