import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function extractRef(text: string, content: string): string {
  const line = text.split("\n").find((l: string) => l.includes(`│${content}`))!;
  return line.replace(/^[+\- ]/, "").trim();
}

describe("chained line edits", () => {
  it("returns line-numbered diff for a single-line replace", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const betaRef = extractRef(firstRead.content[0].text, "beta");

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          edits: [{ range: [betaRef, betaRef], lines: ["BETA"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Diff shows the change with line numbers
      expect(editResult.content[0].text).toMatch(/\+2[A-Za-z0-9_\\-]{3}│/);
      expect(editResult.content[0].text).toContain("│BETA");

      // Extract fresh line number from diff and chain another edit
      const freshRef = extractRef(editResult.content[0].text, "BETA");

      const editResult2 = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          edits: [{ range: [freshRef, freshRef], lines: ["BETA-CHAINED"] }],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult2.content[0].text).toMatch(/\+2[A-Za-z0-9_\\-]{3}│/);
      expect(editResult2.content[0].text).toContain("│BETA-CHAINED");
    });
  });

  it("shows full diff even for large changes", async () => {
    const fifteenLines = Array.from(
      { length: 15 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    await withTempFile("big.ts", fifteenLines, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute(
        "r1",
        { path: "big.ts" },
        undefined,
        undefined,
        ctx,
      );
      const line1Ref = extractRef(firstRead.content[0].text, "line 1");
      const line15Ref = extractRef(firstRead.content[0].text, "line 15");

      const newLines = Array.from({ length: 15 }, (_, i) => `NEW ${i + 1}`);
      const editResult = await editTool.execute(
        "e1",
        {
          path: "big.ts",
          edits: [{ range: [line1Ref, line15Ref], lines: newLines }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Diff is always shown; no "anchors omitted" fallback
      expect(editResult.content[0].text).toMatch(/\+\s*1[A-Za-z0-9_\\-]{3}│/);
      expect(editResult.content[0].text).not.toContain("Anchors omitted");
    });
  });

  it("returns diff for append operation", async () => {
    await withTempFile("app.ts", "existing\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute(
        "r1",
        { path: "app.ts" },
        undefined,
        undefined,
        ctx,
      );
      const existingRef = extractRef(firstRead.content[0].text, "existing");

      const editResult = await editTool.execute(
        "e1",
        {
          path: "app.ts",
          edits: [
            {
              range: [existingRef, existingRef],
              lines: ["existing", "appended"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toMatch(/\+2[A-Za-z0-9_\\-]{3}│/);
      expect(editResult.content[0].text).toContain("│appended");
    });
  });

  it("returns diff for prepend at BOF", async () => {
    await withTempFile("pre.ts", "existing\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute(
        "r1",
        { path: "pre.ts" },
        undefined,
        undefined,
        ctx,
      );
      const existingRef = extractRef(firstRead.content[0].text, "existing");

      const editResult = await editTool.execute(
        "e1",
        {
          path: "pre.ts",
          edits: [
            {
              range: [existingRef, existingRef],
              lines: ["prepended", "existing"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toMatch(/\+1[A-Za-z0-9_\\-]{3}│/);
      expect(editResult.content[0].text).toContain("│prepended");
    });
  });

  it("does not leak terminal-newline sentinel in diff for append on newline-terminated file", async () => {
    await withTempFile("sentinel.ts", "existing\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute(
        "r1",
        { path: "sentinel.ts" },
        undefined,
        undefined,
        ctx,
      );
      const existingRef = extractRef(firstRead.content[0].text, "existing");

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sentinel.ts",
          edits: [
            {
              range: [existingRef, existingRef],
              lines: ["existing", "appended"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // No empty line-numbered diff rows should appear.
      const numberedLines = editResult.content[0].text
        .split("\n")
        .filter((line: string) =>
          line.match(/^[+\- ]\s*\d+[A-Za-z0-9_\\-]{3}│.*/),
        );
      for (const line of numberedLines) {
        expect(line).not.toMatch(/^\s*\d+[A-Za-z0-9_\\-]{3}│$/);
      }
    });
  });

  it("shows diff when single-line replace expands", async () => {
    await withTempFile(
      "expand.ts",
      "before\ntarget\nafter\n",
      async ({ cwd }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const ctx = { cwd, ui: { notify() {} } } as any;

        const readTool = getTool("read");
        const editTool = getTool("edit");

        const firstRead = await readTool.execute(
          "r1",
          { path: "expand.ts" },
          undefined,
          undefined,
          ctx,
        );
        const targetRef = extractRef(firstRead.content[0].text, "target");

        const newLines = Array.from(
          { length: 11 },
          (_, i) => `EXPANDED ${i + 1}`,
        );
        const editResult = await editTool.execute(
          "e1",
          {
            path: "expand.ts",
            edits: [{ range: [targetRef, targetRef], lines: newLines }],
          },
          undefined,
          undefined,
          ctx,
        );

        // Diff always shown; no budget-based omission
        expect(editResult.content[0].text).toMatch(/\+\s*2[A-Za-z0-9_\\-]{3}│/);
        expect(editResult.content[0].text).not.toContain("Anchors omitted");
      },
    );
  });

  it("distant unchanged line anchors remain valid after chained edits", async () => {
    // Context hashing: only immediate neighbors affect the hash. Editing line 4
    // of a 4-line file should not invalidate line 1's anchor.
    await withTempFile("stale.ts", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute(
        "r1",
        { path: "stale.ts" },
        undefined,
        undefined,
        ctx,
      );
      const dRef = extractRef(firstRead.content[0].text, "d");
      const aRef = extractRef(firstRead.content[0].text, "a");

      await editTool.execute(
        "e1",
        { path: "stale.ts", edits: [{ range: [dRef, dRef], lines: ["D"] }] },
        undefined,
        undefined,
        ctx,
      );

      const refreshedRead = await readTool.execute(
        "r2",
        { path: "stale.ts" },
        undefined,
        undefined,
        ctx,
      );
      const refreshedDRef = extractRef(refreshedRead.content[0].text, "D");
      await editTool.execute(
        "e2-refreshed",
        {
          path: "stale.ts",
          edits: [
            { range: [refreshedDRef, refreshedDRef], lines: ["D-AGAIN"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      // Distant line 1 anchor is still valid (neighbors unchanged)
      const aEdit = await editTool.execute(
        "e3",
        { path: "stale.ts", edits: [{ range: [aRef, aRef], lines: ["A"] }] },
        undefined,
        undefined,
        ctx,
      );
      expect(aEdit.content[0].text).toMatch(/\+1[A-Za-z0-9_\\-]{3}│/);
      expect(aEdit.content[0].text).toContain("│A");
    });
  });
});
