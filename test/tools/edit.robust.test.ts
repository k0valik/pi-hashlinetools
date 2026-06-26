import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registerEditTool } from "../../src/edit";
import { computePublicLineChecksum } from "../../src/line-ref";
import {
  expectRefusedWithError,
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

describe("edit.robust.test.ts - Basic Operations", () => {
  it("executes replace op", async () => {
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["line1", "line2", "line3"];
        const ref2 = fullHashRef(lines, 2);

        await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [{ op: "replace", range: [ref2, ref2], lines: ["LINE2"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("line1\nLINE2\nline3\n");
      },
    );
  });

  it("executes append op", async () => {
    await withTempFile("test.txt", "line1\nline2\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["line1", "line2"];
      const ref1 = fullHashRef(lines, 1);

      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ op: "append", pos: ref1, lines: ["inserted"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("line1\ninserted\nline2\n");
    });
  });

  it("executes prepend op", async () => {
    await withTempFile("test.txt", "line1\nline2\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["line1", "line2"];
      const ref2 = fullHashRef(lines, 2);

      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ op: "prepend", pos: ref2, lines: ["inserted"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("line1\ninserted\nline2\n");
    });
  });

  it("executes replace_text op", async () => {
    await withTempFile("test.txt", "hello world\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ op: "replace_text", oldText: "world", newText: "pi" }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("hello pi\n");
    });
  });
});

describe("edit.robust.test.ts - Stale Anchor Recovery", () => {
  it("Layer 1: Exact content match with stale checksum", async () => {
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        // Manually construct a ref with WRONG checksum but RIGHT content
        // Use 'aa' which is valid hex
        const staleRef = "2aa│line2";

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [{ range: [staleRef, staleRef], lines: ["LINE2"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("line1\nLINE2\nline3\n");
        expect(result.content[0].text).toContain("[W_STALE_CONTEXT]");
      },
    );
  });

  it("Layer 2-3: Fuzzy relocation within radius", async () => {
    await withTempFile(
      "test.txt",
      "line1\nline2\nline3\nline4\nline5\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        // Target line 2, but "line2" moved to line 4
        await readFile(path, "utf-8"); // just to be sure
        await writeFile(
          path,
          "line1\nEXTRA\nEXTRA\nline2\nline3\nline4\nline5\n",
        );

        const staleRef = "2AA│line2"; // Says line 2, but it's now at line 4

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [{ range: [staleRef, staleRef], lines: ["LINE2"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        const final = await readFile(path, "utf-8");
        expect(final).toContain("EXTRA\nEXTRA\nLINE2\nline3");
        // The user-facing text was cleaned up: "content moved from line X
        // to Y" became "line X content has moved to line Y".
        expect(result.content[0].text).toMatch(
          /line 2 content has moved to line 4/,
        );
      },
    );
  });

  it("Layer 4: Hash-index relocation (no content hint)", async () => {
    const oldLines = ["111", "222", "333", "444", "555"];
    await withTempFile(
      "test.txt",
      oldLines.join("\n") + "\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        // 333 is at line 3, neighbors 222 and 444.
        const cs3 = computePublicLineChecksum(oldLines, 3);

        // Move 222, 333, 444 together so 333's checksum is stable
        const newLines = ["aaa", "bbb", "222", "333", "444", "ccc"];
        await writeFile(path, newLines.join("\n") + "\n");

        // Ref with checksum but empty content hint: "3${cs3}│"
        // This avoids tryResolveCompactRef and forces Layer 4 if content-hint (empty) doesn't match line 3.
        const compactRef = `3${cs3}│`;

        const result = await editTool.execute(
          "e1",
          {
            path: "test.txt",
            edits: [
              { range: [compactRef, compactRef], lines: ["REPLACED_333"] },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        const final = await readFile(path, "utf-8");
        expect(final).toContain("REPLACED_333");
        expect(result.content[0].text).toContain("[W_HASH_RELOCATE]");
      },
    );
  });

  it("Layer 5: Byte-level relocation", async () => {
    // Create a file with many lines to exceed fuzzy radius (40)
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const content = lines.join("\n") + "\n";

    await withTempFile("test.txt", content, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const ref50 = fullHashRef(lines, 50);

      // Move line 50 way down (by 60 lines)
      const newLines = [...lines];
      newLines.splice(
        0,
        0,
        ...Array.from({ length: 60 }, (_, i) => `Extra ${i}`),
      );
      await writeFile(path, newLines.join("\n") + "\n");

      const result = await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ range: [ref50, ref50], lines: ["REPLACED_50"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const final = await readFile(path, "utf-8");
      expect(final).toContain("REPLACED_50");
      //  unblocks Layer 4 (hash-index) as a soft fallback, so it may
      // win here over Layer 5. Both are valid relocation signals for
      // shifts beyond the fuzzy radius. The file must be edited and the
      // warning must mention some form of relocation.
      const text = result.content[0].text;
      expect(text).toMatch(/\[W_(BYTE|HASH)_RELOCATE\]/);
    });
  });
});

describe("edit.robust.test.ts - Boundary Conditions", () => {
  it("edits the first line", async () => {
    await withTempFile("test.txt", "line1\nline2\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const ref1 = fullHashRef(["line1", "line2"], 1);

      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ range: [ref1, ref1], lines: ["FIRST"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("FIRST\nline2\n");
    });
  });

  it("edits the last line", async () => {
    await withTempFile("test.txt", "line1\nline2\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const ref2 = fullHashRef(["line1", "line2"], 2);

      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ range: [ref2, ref2], lines: ["LAST"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("line1\nLAST\n");
    });
  });

  it("handles single-line files", async () => {
    await withTempFile("test.txt", "only line\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const ref1 = fullHashRef(["only line"], 1);

      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ range: [ref1, ref1], lines: ["REPLACED"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("REPLACED\n");
    });
  });
});

describe("edit.robust.test.ts - Rejection Cases", () => {
  it("strips display prefixes from replacement lines", async () => {
    await withTempFile("test.txt", "line1\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const ref1 = fullHashRef(["line1"], 1);

      // The tool is supposed to strip these prefixes.
      // Note: currently there's a bug where it strips silently in hashlineParseText,
      // so the warning might be missing. We verify the stripping.
      await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [
            { range: [ref1, ref1], lines: [" 1#aB3│line1", "+2#xYz│new line"] },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("line1\nnew line\n");
    });
  });

  it("rejects asymmetric shift (E_ASYMMETRIC_SHIFT)", async () => {
    await withTempFile("test.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["a", "b", "c", "d", "e"];
      const refB = fullHashRef(lines, 2);
      const refD = fullHashRef(lines, 4);

      // Break the structure between b and d
      await writeFile(path, "a\nb\nINSERTED\nc\nd\ne\n");

      const result = await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [{ range: [refB, refD], lines: ["B", "C", "D"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      expectRefusedWithError(result, /\[E_ASYMMETRIC_SHIFT\]/);
    });
  });

  it("rejects overlapping ranges (E_EDIT_CONFLICT)", async () => {
    await withTempFile("test.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["a", "b", "c", "d", "e"];
      const refA = fullHashRef(lines, 1);
      const refC = fullHashRef(lines, 3);
      const refB = fullHashRef(lines, 2);
      const refD = fullHashRef(lines, 4);

      const result = await editTool.execute(
        "e1",
        {
          path: "test.txt",
          edits: [
            { range: [refA, refC], lines: ["X"] },
            { range: [refB, refD], lines: ["Y"] },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      expectRefusedWithError(result, /\[E_EDIT_CONFLICT\]/);
    });
  });

  it("rejects edits that would empty a large file (E_WOULD_EMPTY)", async () => {
    const largeContent =
      Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n") + "\n";
    await withTempFile("large.txt", largeContent, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = largeContent.trim().split("\n");
      const refStart = fullHashRef(lines, 1);
      const refEnd = fullHashRef(lines, 60);

      await expect(
        editTool.execute(
          "e1",
          {
            path: "large.txt",
            edits: [{ range: [refStart, refEnd], lines: [] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/\[E_WOULD_EMPTY\]/);
    });
  });

  it("rejects edits on empty files (E_EMPTY_FILE)", async () => {
    await withTempFile("empty.txt", "", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "empty.txt",
            edits: [{ range: ["1AA│", "1AA│"], lines: ["content"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/\[E_EMPTY_FILE\]/);
    });
  });

  it("handles multi-op edits (replace + append + prepend)", async () => {
    await withTempFile(
      "multi.txt",
      "a\nb\nc\nd\ne\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        const refA = "1aa│a";
        const refC = "3cc│c";
        const refE = "5ee│e";

        await editTool.execute(
          "e1",
          {
            path: "multi.txt",
            edits: [
              { op: "replace", range: [refA, refA], lines: ["A"] },
              { op: "append", pos: refC, lines: ["C+"] },
              { op: "prepend", pos: refE, lines: ["E-"] },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nC+\nd\nE-\ne\n");
      },
    );
  });

  it("replace_text with special characters and multiline text", async () => {
    await withTempFile(
      "special.txt",
      "const x = (y) => { return y * 2; };\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        await editTool.execute(
          "e1",
          {
            path: "special.txt",
            edits: [
              {
                op: "replace_text",
                oldText: "(y) => { return y * 2; }",
                newText: "(z) => z * 3",
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("const x = (z) => z * 3;\n");
      },
    );
  });

  it("fuzzy relocation: multiple matches → E_RELOCATE_AMBIGUOUS ", async () => {
    await withTempFile(
      "multi_match.txt",
      "target\nother\ntarget\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        // Force it to look for 'target' somewhere else by shifting it
        await writeFile(path, "EXTRA\ntarget\nother\ntarget\n");

        const staleRef = "1aa│target"; // originally line 1, now at line 2 and 4

        const result = await editTool.execute(
          "e1",
          {
            path: "multi_match.txt",
            edits: [{ range: [staleRef, staleRef], lines: ["REPLACED"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );
        // Previously: E_LINE_CHANGED (misleading — suggested stale
        // context rather than duplicate content). Now: E_RELOCATE_AMBIGUOUS.
        expectRefusedWithError(result, /\[E_RELOCATE_AMBIGUOUS\]/);
      },
    );
  });

  it("handles CRLF line endings", async () => {
    await withTempFile(
      "crlf.txt",
      "line 1\r\nline 2\r\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const ref1 = "1aa│line 1";

        await editTool.execute(
          "e1",
          {
            path: "crlf.txt",
            edits: [{ range: [ref1, ref1], lines: ["NEW 1"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        const content = await readFile(path, "utf-8");
        expect(content).toBe("NEW 1\r\nline 2\r\n");
      },
    );
  });
});
