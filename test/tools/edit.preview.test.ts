import { chmod } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeEditPreview } from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { withTempFile } from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
  loadFileKindAndText: vi.fn(),
  classifyFileKind: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

describe("computeEditPreview", () => {
  beforeEach(() => {
    vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
    vi.mocked(fileKindMod.classifyFileKind).mockReset();
  });

  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "aaa\nbbb\nccc\n",
      });

      const betaRef = `2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}│bbb`;
      const preview = await computeEditPreview(
        {
          path: "sample.txt",
          edits: [{ range: [betaRef, betaRef], lines: ["BBB"] }],
        },
        cwd,
      );

      expect("diff" in preview).toBe(true);
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toMatch(/\+2[A-Za-z0-9_\\-]{3}│/);
      expect(preview.diff).toContain("│BBB");
    });
  });

  it("still computes a preview diff for read-only files", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
          kind: "text",
          text: "aaa\nbbb\nccc\n",
        });

        await chmod(path, 0o444);
        const betaRef = `2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}│bbb`;

        try {
          const preview = await computeEditPreview(
            {
              path: "sample.txt",
              edits: [{ range: [betaRef, betaRef], lines: ["BBB"] }],
            },
            cwd,
          );

          expect("diff" in preview).toBe(true);
          if (!("diff" in preview)) {
            return;
          }
          expect(preview.diff).toContain("│BBB");
        } finally {
          await chmod(path, 0o644);
        }
      },
    );
  });

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    await withTempFile("sample.txt", "ignored\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "aaa\nbbb\nccc\n",
      });
      vi.mocked(fileKindMod.classifyFileKind).mockRejectedValue(
        new Error("preview should not call classifyFileKind on text paths"),
      );

      const betaRef = `2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}│bbb`;
      const preview = await computeEditPreview(
        {
          path: "sample.txt",
          edits: [{ range: [betaRef, betaRef], lines: ["BBB"] }],
        },
        cwd,
      );

      expect("diff" in preview).toBe(true);
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toContain("│BBB");
      expect(vi.mocked(fileKindMod.classifyFileKind)).not.toHaveBeenCalled();
    });
  });

  it("does not let a delayed preview resurrect after a settled result", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      let loadCount = 0;
      vi.mocked(fileKindMod.loadFileKindAndText).mockImplementation(
        async () => {
          loadCount += 1;
          if (loadCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return { kind: "text", text: "aaa\nbbb\nccc\n" };
        },
      );

      const betaRef = `2#${computeLineHash(["aaa", "bbb", "ccc"], 1)}│bbb`;
      const editArgs = {
        path: "sample.txt",
        edits: [{ range: [betaRef, betaRef], lines: ["BBB"] }],
      };

      // Import registerEditTool to set up the tool with its render methods
      const { registerEditTool } = await import("../../src/edit");
      const tools = new Map<string, any>();
      const pi = {
        registerTool(tool: any) {
          tools.set(tool.name, tool);
        },
        on() {},
      };
      registerEditTool(pi as any);
      const tool = tools.get("edit");
      if (!tool) throw new Error("Tool not registered: edit");

      const theme = {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      };
      const state: Record<string, unknown> = {};

      tool.renderCall(editArgs, theme, {
        argsComplete: true,
        state,
        cwd,
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      });

      const result = await tool.execute("e1", editArgs, undefined, undefined, {
        cwd,
      });
      tool.renderResult(result, { expanded: false, isPartial: false }, theme, {
        args: editArgs,
        state,
        isError: false,
        lastComponent: undefined,
        invalidate() {},
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(state.preview ?? null).toBeNull();
    });
  });
});
it("returns an error for empty files", async () => {
  await withTempFile("empty.txt", "", async ({ cwd }) => {
    vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
      kind: "text",
      text: "",
    });

    const preview = await computeEditPreview(
      {
        path: "empty.txt",
        edits: [{ range: ["1#AB", "1#AB"], lines: ["hello"] }],
      },
      cwd,
    );

    expect("error" in preview).toBe(true);
    if (!("error" in preview)) return;
    expect(preview.error).toContain("empty");
    expect(preview.error).toContain("write tool");
  });
});

it("applies replace_text before computing the diff preview", async () => {
  await withTempFile("sample.txt", "const x = 42;\n", async ({ cwd }) => {
    vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
      kind: "text",
      text: "const x = 42;\n",
    });

    const preview = await computeEditPreview(
      {
        path: "sample.txt",
        edits: [{ op: "replace_text", oldText: "42", newText: "99" }],
      },
      cwd,
    );

    expect("diff" in preview).toBe(true);
    if (!("diff" in preview)) return;
    expect(preview.diff).toContain("│const x = 99");
    // The diff format includes the original text in removed-line annotations,
    // so we check for the removal marker (-1) instead of asserting absence.
    expect(preview.diff).toContain("-1");
  });
});
