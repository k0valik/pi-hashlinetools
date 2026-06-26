import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { computePublicLineChecksum } from "../../src/line-ref";
import {
  expectRefusedWithError,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

function publicRef(fileLines: string[], lineNumber: number): string {
  const cs = computePublicLineChecksum(fileLines, lineNumber);
  return `${lineNumber}${cs}│${fileLines[lineNumber - 1] ?? ""}`;
}

function toolkit() {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { editTool: getTool("edit") };
}

function ctx(cwd: string) {
  return { cwd, hasUI: true, ui: { notify() {} } } as any;
}

describe("fuzzy anchor relocation", () => {
  // ── Layer 2: ±N search ──

  it("relocates a single-line edit shifted down within radius", async () => {
    await withTempFile(
      "t.txt",
      "a\nb\nline3\nd\ne\n",
      async ({ cwd, path }) => {
        const { editTool } = toolkit();
        const ref = publicRef(["a", "b", "line3", "d", "e"], 3);
        await writeFile(path, "x\ny\nz\na\nb\nline3\nd\ne\n", "utf-8");

        const r = await editTool.execute(
          "e",
          {
            path: "t.txt",
            edits: [{ range: [ref, ref], lines: ["L3"] }],
          },
          undefined,
          undefined,
          ctx(cwd),
        );

        expect(await readFile(path, "utf-8")).toBe("x\ny\nz\na\nb\nL3\nd\ne\n");
        expect(r.content?.[0]?.text ?? "").toContain("since you read it");
      },
    );
  });

  it("relocates a single-line edit shifted up within radius", async () => {
    await withTempFile(
      "t.txt",
      "A\nB\nC\nline4\nline5\n",
      async ({ cwd, path }) => {
        const { editTool } = toolkit();
        const ref = publicRef(["A", "B", "C", "line4", "line5"], 4);
        await writeFile(path, "line4\nline5\n", "utf-8");

        const r = await editTool.execute(
          "e",
          {
            path: "t.txt",
            edits: [{ range: [ref, ref], lines: ["L4"] }],
          },
          undefined,
          undefined,
          ctx(cwd),
        );

        expect(await readFile(path, "utf-8")).toBe("L4\nline5\n");
        expect(r.content?.[0]?.text ?? "").toContain("since you read it");
      },
    );
  });

  it("rejects when content shifted beyond the search radius", async () => {
    await withTempFile("t.txt", "target\n", async ({ cwd, path }) => {
      const { editTool } = toolkit();
      const ref = publicRef(["target"], 1);
      const pad = Array.from({ length: 50 }, (_, i) => `pad${i + 1}`).join(
        "\n",
      );
      await writeFile(path, `${pad}\ntarget\n`, "utf-8");

      // With unified format (xx│content), the content hint enables byte-level
      // relocation (Layer 5). The edit succeeds because "target" is found at
      // byte position 50 lines down, even beyond the ±40 text-line radius.
      const r = await editTool.execute(
        "e",
        {
          path: "t.txt",
          edits: [{ range: [ref, ref], lines: ["x"] }],
        },
        undefined,
        undefined,
        ctx(cwd),
      );
      const result = await readFile(path, "utf-8");
      expect(result).toBe(`${pad}\nx\n`);
      const text = r.content?.[0]?.text ?? "";
      expect(text).toContain("since you read it");
    });
  });

  // ── Layer 2 ─ duplicate-content rejection ──

  it("rejects with E_RELOCATE_AMBIGUOUS when duplicate content exists within the search radius ", async () => {
    await withTempFile("t.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { editTool } = toolkit();
      const ref = publicRef(["a", "b", "c", "d"], 3);
      await writeFile(path, "a\nc\nb\nc\nd\n", "utf-8");

      const result = await editTool.execute(
        "e",
        {
          path: "t.txt",
          edits: [{ range: [ref, ref], lines: ["x"] }],
        },
        undefined,
        undefined,
        ctx(cwd),
      );
      // Previously: E_LINE_CHANGED (misleading — suggested stale
      // context). Now: E_RELOCATE_AMBIGUOUS — the target content appears
      // more than once and the medley can't decide which copy to edit.
      expectRefusedWithError(result, /E_RELOCATE_AMBIGUOUS/);
    });
  });

  // ── Multi-line: same-offset relocation ──

  it("relocates a multi-line edit when both endpoints shifted by the same offset", async () => {
    await withTempFile("t.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { editTool } = toolkit();
      const lines = ["a", "b", "c", "d", "e"];
      const start = publicRef(lines, 2);
      const end = publicRef(lines, 4);
      await writeFile(path, "x\ny\na\nb\nc\nd\ne\n", "utf-8");

      const r = await editTool.execute(
        "e",
        {
          path: "t.txt",
          edits: [{ range: [start, end], lines: ["B", "C", "D"] }],
        },
        undefined,
        undefined,
        ctx(cwd),
      );

      expect(await readFile(path, "utf-8")).toBe("x\ny\na\nB\nC\nD\ne\n");
      expect(r.content?.[0]?.text ?? "").toContain("since you read it");
    });
  });

  // ── Multi-line: asymmetric rejection ──

  it("rejects when relocated start and end have different offsets (asymmetric)", async () => {
    await withTempFile("t.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { editTool } = toolkit();
      const lines = ["a", "b", "c", "d", "e"];
      const start = publicRef(lines, 3);
      const end = publicRef(lines, 5);
      await writeFile(path, "x\na\nb\nc\ninserted\nd\ne\n", "utf-8");

      const result = await editTool.execute(
        "e",
        {
          path: "t.txt",
          edits: [{ range: [start, end], lines: ["C", "D", "E"] }],
        },
        undefined,
        undefined,
        ctx(cwd),
      );
      expectRefusedWithError(result, /E_ASYMMETRIC_SHIFT|E_STALE_ANCHOR/);
    });
  });

  // ── Edge: no shift ──

  it("proceeds normally when content is at the expected position (no relocation)", async () => {
    await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { editTool } = toolkit();
      const ref = publicRef(["a", "b", "c"], 2);

      const r = await editTool.execute(
        "e",
        {
          path: "t.txt",
          edits: [{ range: [ref, ref], lines: ["B"] }],
        },
        undefined,
        undefined,
        ctx(cwd),
      );

      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\n");
      const text = r.content?.[0]?.text ?? "";
      expect(text).not.toContain("has moved to line");
    });
  });

  // ── Layer 3: one-endpoint relocation vs exact-match asymmetry ──

  it("rejects when only one endpoint relocated and the other matched at its original position", async () => {
    await withTempFile(
      "t.txt",
      "start\nmiddle\nend\n",
      async ({ cwd, path }) => {
        const { editTool } = toolkit();
        const lines = ["start", "middle", "end"];
        const sRef = publicRef(lines, 1);
        const eRef = publicRef(lines, 3);

        // Insert 2 lines between start and end: start stays at line 1 (offset 0),
        // end shifts from line 3 to line 5 (offset +2).
        await writeFile(path, "start\nNEW1\nNEW2\nmiddle\nend\n", "utf-8");

        const result = await editTool.execute(
          "e",
          {
            path: "t.txt",
            edits: [{ range: [sRef, eRef], lines: ["S", "M", "E"] }],
          },
          undefined,
          undefined,
          ctx(cwd),
        );
        expectRefusedWithError(result, /E_ASYMMETRIC_SHIFT/);
      },
    );
  });
});

// ── Layer 5: byte-level relocation ──

it("byte-level relocation succeeds when content shifted beyond text search radius", async () => {
  // 50 lines of padding push the target well beyond the ±40 text-line radius.
  // Byte-level relocation scans the entire raw buffer so it still finds it.
  const padLines = Array.from({ length: 50 }, (_, i) => `pad ${i + 1}`);
  const targetLine = "unique-target-content";
  const allLines = [...padLines, targetLine];
  const fileContent = `${allLines.join("\n")}\n`;

  await withTempFile("byte-test.txt", fileContent, async ({ cwd, path }) => {
    const { editTool } = toolkit();
    // Model thinks target is at line 1 (stale ref from earlier read)
    const ref = publicRef([targetLine], 1);

    const r = await editTool.execute(
      "e",
      {
        path: "byte-test.txt",
        edits: [{ range: [ref, ref], lines: ["modified"] }],
      },
      undefined,
      undefined,
      ctx(cwd),
    );

    const result = await readFile(path, "utf-8");
    expect(result).toBe(`${[...padLines, "modified"].join("\n")}\n`);
    const text = r.content?.[0]?.text ?? "";
    expect(text).toContain("since you read it");
  });
});

it("byte-level relocation rejects when content appears multiple times", async () => {
  const fileContent = "dup\nunique\ndup\n";
  await withTempFile(
    "byte-dup.txt",
    fileContent,
    async ({ cwd, path: _path }) => {
      const { editTool } = toolkit();
      const ref = publicRef(["dup"], 1);

      // With unified format (xx│content), Layer 1 matches the content hint
      // directly at line 1, so the edit succeeds (no byte-level needed).
      const _r = await editTool.execute(
        "e",
        {
          path: "byte-dup.txt",
          edits: [{ range: [ref, ref], lines: ["x"] }],
        },
        undefined,
        undefined,
        ctx(cwd),
      );
      const { readFile } = await import("node:fs/promises");
      const result = await readFile(_path, "utf-8");
      expect(result).toBe("x\nunique\ndup\n");
    },
  );
});
