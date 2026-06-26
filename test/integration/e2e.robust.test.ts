import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

describe("e2e.robust.test.ts - End-to-End Robustness", () => {
  it("chains multiple edits using fresh anchors from results", async () => {
    await withTempFile(
      "chain.txt",
      "line 1\nline 2\nline 3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const readTool = getTool("read");
        const editTool = getTool("edit");

        // 1. Read the file
        const readResult = await readTool.execute(
          "r1",
          { path: "chain.txt" },
          undefined,
          undefined,
          { cwd } as any,
        );
        const lines = readResult.content[0].text
          .split("\n")
          .filter((l: string) => l.includes("│"));

        // 2. Edit line 2
        const edit1Result = await editTool.execute(
          "e1",
          {
            path: "chain.txt",
            edits: [{ range: [lines[1], lines[1]], lines: ["NEW LINE 2"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          "line 1\nNEW LINE 2\nline 3\n",
        );

        // 3. Extract fresh anchors from edit result.
        // The result text contains "Post-edit anchors (use for subsequent edits to avoid re-reading):"
        const resultText = edit1Result.content[0].text;
        const freshAnchors = resultText
          .split("\n")
          .filter((l: string) => l.includes("│"))
          .map((l: string) => l.trim());

        // freshAnchors should cover changed line (line 2) + context.
        // Let's pick line 3 from fresh anchors.
        const line3Anchor = freshAnchors.find((a: string) => a.startsWith("3"));
        expect(line3Anchor).toBeDefined();

        // 4. Edit line 3 using fresh anchor
        await editTool.execute(
          "e2",
          {
            path: "chain.txt",
            edits: [
              { range: [line3Anchor!, line3Anchor!], lines: ["NEW LINE 3"] },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          "line 1\nNEW LINE 2\nNEW LINE 3\n",
        );
      },
    );
  });

  it("handles edits through symlinks", async () => {
    await withTempFile(
      "target.txt",
      "original content\n",
      async ({ cwd, path: targetPath }) => {
        const linkPath = join(cwd, "link.txt");
        await symlink(targetPath, linkPath);

        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const readTool = getTool("read");

        // Read through link
        const readResult = await readTool.execute(
          "r1",
          { path: "link.txt" },
          undefined,
          undefined,
          { cwd } as any,
        );
        const line1 = readResult.content[0].text
          .split("\n")
          .find((l: string) => l.includes("│"));

        // Edit through link
        await editTool.execute(
          "e1",
          {
            path: "link.txt",
            edits: [{ range: [line1!, line1!], lines: ["updated content"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(targetPath, "utf-8")).toBe("updated content\n");
      },
    );
  });

  it("handles undo after chained edits", async () => {
    await withTempFile("undo_chain.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const undoTool = getTool("undo");

      // Edit 1: a -> A
      await editTool.execute(
        "e1",
        {
          path: "undo_chain.txt",
          edits: [{ range: ["1aa│a", "1aa│a"], lines: ["A"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      // Edit 2: b -> B
      await editTool.execute(
        "e2",
        {
          path: "undo_chain.txt",
          edits: [{ range: ["2bb│b", "2bb│b"], lines: ["B"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("A\nB\nc\n");

      // Undo Edit 2
      await undoTool.execute("u1", {}, undefined, undefined, { cwd } as any);
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");
    });
  });

  it("handles sequential edits to the same file with automatic recovery from shifts", async () => {
    await withTempFile(
      "recovery.txt",
      "target line\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        // 1. First edit prepends a line, shifting "target line" to line 2.
        const e1 = await editTool.execute(
          "e1",
          {
            path: "recovery.txt",
            edits: [
              {
                op: "prepend",
                pos: "1aa│target line",
                lines: ["new first line"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          "new first line\ntarget line\n",
        );

        // 2. Second edit targets "target line" using STALE anchor (says line 1).
        // Auto-re-read and fuzzy relocation should find it at line 2.
        const e2 = await editTool.execute(
          "e2",
          {
            path: "recovery.txt",
            edits: [
              {
                op: "replace",
                range: ["1aa│target line", "1aa│target line"],
                lines: ["edited target"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          "new first line\nedited target\n",
        );
        // User-facing text was cleaned up: "content moved from line X to
        // Y" became "line X content has moved to line Y".
        expect(e2.content[0].text).toMatch(
          /line 1 content has moved to line 2/,
        );
      },
    );
  });

  it("interleaves read, write, and edit", async () => {
    await withTempFile("interleave.txt", "start\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const writeTool = getTool("write");
      const editTool = getTool("edit");

      // 1. Read
      await readTool.execute(
        "r1",
        { path: "interleave.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      // 2. Write (wholesale replacement)
      await writeTool.execute(
        "w1",
        { path: "interleave.txt", content: "new starting point\n" },
        undefined,
        undefined,
        { cwd } as any,
      );

      // 3. Read again to get fresh anchors
      const r2 = await readTool.execute(
        "r2",
        { path: "interleave.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      const anchor = r2.content[0].text
        .split("\n")
        .find((l: string) => l.includes("│"));

      // 4. Edit
      await editTool.execute(
        "e1",
        {
          path: "interleave.txt",
          edits: [{ range: [anchor!, anchor!], lines: ["edited after write"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("edited after write\n");
    });
  });
});
