import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  assertEditRequest,
  computeEditPreview,
  hashlineEditToolSchema,
  normalizeEditItems,
  registerEditTool,
} from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { computePublicLineChecksum } from "../../src/line-ref";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("assertEditRequest", () => {
  it("accepts valid replace edit envelope", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ range: ["1a│old", "1a│old"], lines: ["x"] }],
      }),
    ).not.toThrow();
  });
});

describe("registerEditTool", () => {
  it("publishes a schema that validates long-form endpoint refs", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [
          {
            op: "replace",
            range: ["1a│old", "1a│old"],
            lines: ["x"],
            intent: "Make the target line contain the expected fixture value.",
            rationale:
              "This exercises the published hashline edit payload with required full endpoint refs.",
          },
        ],
      }),
    ).toBe(true);
  });

  it("schema is permissive — runtime validates op/range requirements", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    // Ambiguous shapes pass schema validation (additionalProperties: true)
    // but are caught at runtime by normalizeEditItems with clear error messages.
    //
    // P4 (edit): op is required per-edit, so the test inputs now include
    // `op: "append"` / `op: "prepend"`. The schema still permits the bad
    // `after` / `before` field names (additionalProperties: true); the
    // runtime catches them.
    expect(
      validate({
        path: "a.ts",
        edits: [
          {
            op: "append",
            after: "1#AB",
            lines: ["x"],
            intent: "Attempt an append-style edit shape.",
            rationale:
              "Shape passes schema but normalizeEditItems rejects unknown ops at runtime.",
          },
        ],
      }),
    ).toBe(true);

    expect(
      validate({
        path: "a.ts",
        edits: [
          {
            op: "prepend",
            before: "1#AB",
            lines: ["x"],
            intent: "Attempt a prepend-style edit shape.",
            rationale:
              "Shape passes schema but normalizeEditItems rejects unknown ops at runtime.",
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts edits with extra properties via additionalProperties: true", () => {
    // intent/rationale were removed from schema in 0.3.0 - still accepted via
    // additionalProperties: true on the edit entry schema.
    // P4 (edit): op is now required per-edit, so the test inputs add it.
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const validEdit = {
      op: "replace",
      range: ["1a│old", "1a│old"],
      lines: ["x"],
    };

    expect(validate({ path: "a.ts", edits: [validEdit] })).toBe(true);

    // Extra properties on an edit entry are tolerated (additionalProperties: true)
    expect(
      validate({
        path: "a.ts",
        edits: [
          { ...validEdit, intent: "test", rationale: "test", extra: "nope" },
        ],
      }),
    ).toBe(true);
  });

  it("publishes an OpenAI-compatible object schema for pi tool registration", () => {
    expect((hashlineEditToolSchema as any).type).toBe("object");
    expect((hashlineEditToolSchema as any).anyOf).toBeUndefined();

    const editsSchema = (hashlineEditToolSchema as any).properties.edits;
    expect(editsSchema.minItems).toBe(1);
    expect(editsSchema.maxItems).toBeUndefined(); // limit was removed — schema is permissive, runtime enforces via auto-re-read retry loop

    const rangeSchema = editsSchema.items.properties.range;
    expect(Array.isArray(rangeSchema.items)).toBe(false);
    expect(rangeSchema.items.type).toBe("string");
    expect(rangeSchema.items.minLength).toBe(1);
    expect(rangeSchema.items.pattern).toContain("[│|]");
    expect(rangeSchema.minItems).toBe(2);
    expect(rangeSchema.maxItems).toBe(2);

    const editProperties = (hashlineEditToolSchema as any).properties.edits
      .items.properties;
    // intent/rationale were removed from schema in 0.3.0
    expect(editProperties.intent).toBeUndefined();
    expect(editProperties.rationale).toBeUndefined();
    expect(editProperties.confidence).toBeUndefined();
    expect(editProperties.confidenceReason).toBeUndefined();
  });

  it("accepts compact and bare-hash range refs in the published schema (warning emitted at execution)", () => {
    // The schema was relaxed: bare hashes (e.g. "1#AB") and legacy single-letter ("1a") refs are now accepted.
    // The orchestrator emits a warning and uses the current file state for the line.
    // Plain line numbers ("1") without any checksum are still rejected (no hash to bind to).
    // P4 (edit): op is now required per-edit, so the test inputs add it.
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const baseEdit = { op: "replace", lines: ["x"] };

    for (const range of [
      ["1a", "1a"],
      ["1#AB", "1#AB"],
    ]) {
      expect(validate({ path: "a.ts", edits: [{ ...baseEdit, range }] })).toBe(
        true,
      );
    }
  });

  it("rejects malformed anchors in the published schema", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const baseEdit = { lines: ["x"] };

    for (const range of [
      ["hello", "world"],
      ["42│line", "42│line"],
      ["42@xy│line", "42@xy│line"],
      // bare number with no checksum suffix is still rejected
      ["1", "1"],
    ]) {
      expect(validate({ path: "a.ts", edits: [{ ...baseEdit, range }] })).toBe(
        false,
      );
    }
  });

  it("registers the edit tool without a prepareArguments shim", () => {
    let registered:
      | {
          parameters?: any;
          prepareArguments?: (args: unknown) => unknown;
        }
      | undefined;
    const pi = {
      registerTool(tool: {
        parameters?: any;
        prepareArguments?: (args: unknown) => unknown;
      }) {
        registered = tool;
      },
    } as any;

    registerEditTool(pi);

    expect(registered?.parameters).toEqual(hashlineEditToolSchema);
    expect(registered?.prepareArguments).toBeUndefined();
  });

  it("silently accepts optional intent/rationale without rendering provenance", () => {
    // Provenance rendering was removed in 0.3.0 - intent/rationale are
    // accepted via additionalProperties but not displayed.
    const { pi, getTool } = makeFakePiRegistry();
    registerEditTool(pi);
    const editTool = getTool("edit");
    const theme = {
      bold: (text: string) => text,
      fg: (_token: string, text: string) => text,
    };

    const component = editTool.renderCall(
      {
        path: "sample.txt",
        edits: [
          {
            range: ["1#AB", "1#AB"],
            lines: ["hello"],
            intent: "Replace the sample greeting.",
            rationale: "The visible call should NOT show provenance.",
          },
        ],
      },
      theme,
      {
        argsComplete: false,
        state: {},
        cwd: process.cwd(),
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      },
    ) as { render: (width: number) => string[] };

    const rendered = component.render(200).join("\n");
    // Provenance rendering was stripped - should not appear
    expect(rendered).not.toContain("Edit provenance");
    expect(rendered).not.toContain("Intent:");
    expect(rendered).not.toContain("Rationale:");
    // But the edit call itself should still render
    expect(rendered).toContain("sample.txt");
  });

  it("executes full endpoint replace through the normal path", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["aaa", "bbb", "ccc"];
        const ref = `2${computePublicLineChecksum(lines, 2)}│bbb`;

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                range: [ref, ref],
                lines: ["BBB"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
        expect(result.details?.diff).toContain("+2");
        expect(result.details?.diff).toContain("│BBB");
      },
    );
  });

  it("renders details diff while keeping diff out of LLM-visible text", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["aaa", "bbb", "ccc"];
      const ref = `2${computePublicLineChecksum(lines, 2)}│bbb`;
      const editArgs = {
        path: "sample.txt",
        edits: [
          {
            range: [ref, ref],
            lines: ["BBB"],
          },
        ],
      };

      const result = await editTool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(typeof editTool.renderResult).toBe("function");

      const component = editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        {
          bold: (text: string) => text,
          fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
        },
        {
          args: editArgs,
          isError: false,
          lastComponent: undefined,
        } as any,
      ) as { render: (width: number) => string[] };

      const rendered = component.render(200).join("\n");

      expect(rendered).not.toContain("Changes: +1 -1");
      expect(rendered).not.toContain("Diff preview:");
      expect(rendered).not.toContain("```diff");
      expect(rendered).toMatch(
        /\[success\]\+2[A-Za-z0-9_\\-]{3}│BBB\[\/success\]/,
      );
      expect(rendered).not.toContain("Updated sample.txt");
      expect(rendered).not.toContain("```text");
      expect(result.details?.diff).toContain("+2");
    });
  });
  it("accepts compact and plain refs at execution time", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      // Compact ref "2b" (public checksum only, no content hint)
      const result1 = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ range: ["2b", "2b"], lines: ["BBB"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      // Should succeed — compact refs are auto-resolved
      expect(result1.details?.metrics?.classification).toBe("applied");

      // Bare line number "2"
      const result2 = await editTool.execute(
        "e2",
        {
          path: "sample.txt",
          edits: [{ range: ["2", "2"], lines: ["CCC"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      expect(result2.details?.metrics?.classification).toBe("applied");

      // File should reflect both edits
      const finalContent = await readFile(path, "utf-8");
      expect(finalContent.replace(/\r/g, "").trim()).toBe("aaa\nCCC");
    });
  });
  it("accepts full endpoint lines and pipe separators with trimmed content matching", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\n   bbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["aaa", "   bbb", "ccc"];
        const ref = `2${computePublicLineChecksum(lines, 2)}|bbb`;

        await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ range: [ref, ref], lines: ["   BBB"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("aaa\n   BBB\nccc\n");
      },
    );
  });

  it("accepts endpoint content containing the separator character", async () => {
    await withTempFile(
      "sample.txt",
      'aaa\nconst text = "a│b";\nccc\n',
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["aaa", 'const text = "a│b";', "ccc"];
        const ref = `2${computePublicLineChecksum(lines, 2)}│const text = "a│b";`;

        await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              { range: [ref, ref], lines: ['const text = "updated│value";'] },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          'aaa\nconst text = "updated│value";\nccc\n',
        );
      },
    );
  });

  it("accepts full endpoint refs for blank lines", async () => {
    await withTempFile("sample.txt", "aaa\n\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const lines = ["aaa", "", "ccc"];
      const ref = `2${computePublicLineChecksum(lines, 2)}│`;

      await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ range: [ref, ref], lines: ["bbb"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });
  it("relocates when endpoint content points at a different line within radius", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["aaa", "bbb", "ccc"];
        const ref = `2${computePublicLineChecksum(lines, 2)}│ccc`;

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ range: [ref, ref], lines: ["BBB"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        // fuzzy relocate finds "ccc" at line 3 despite ref saying line 2
        expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nBBB\n");
        const text = result.content?.[0]?.text ?? "";
        expect(text).toContain("since you read it");
      },
    );
  });

  it("allows a stale public checksum when content-based fuzzy relocation finds it", async () => {
    await withTempFile(
      "sample.txt",
      "AAA\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        // Use a ref whose line number is wrong but content matches elsewhere
        const staleRef = `1${computePublicLineChecksum(["AAA", "bbb", "ccc"], 1)}│bbb`;

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ range: [staleRef, staleRef], lines: ["BBB"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("AAA\nBBB\nccc\n");
        const text = result.content?.[0]?.text ?? "";
        expect(text).toContain("since you read it");
        expect(result.details?.metrics?.warnings).toBeGreaterThan(0);
      },
    );
  });

  it("relocates when stale public checksum content moved to a different line within radius", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nxxx\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const originalLines = ["aaa", "bbb", "ccc"];
        const staleRef = `2${computePublicLineChecksum(originalLines, 2)}│bbb`;

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ range: [staleRef, staleRef], lines: ["BBB"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        // fuzzy relocate finds "bbb" at its new position (line 3 after "xxx" was inserted)
        expect(await readFile(path, "utf-8")).toBe("aaa\nxxx\nBBB\nccc\n");
        const text = result.content?.[0]?.text ?? "";
        expect(text).toContain("since you read it");
      },
    );
  });

  it("accepts more than five edit entries per call (limit removed)", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\nf\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            { range: ["1a│a", "1a│a"], lines: ["A"] },
            { range: ["2b│b", "2b│b"], lines: ["B"] },
            { range: ["3c│c", "3c│c"], lines: ["C"] },
            { range: ["4d│d", "4d│d"], lines: ["D"] },
            { range: ["5e│e", "5e│e"], lines: ["E"] },
            { range: ["6f│f", "6f│f"], lines: ["F"] },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      // 6 edits should succeed — the per-call limit has been removed
      expect(result.details?.metrics?.classification).toBe("applied");
    });
  });

  it("rejects edits on empty files with E_EMPTY_FILE", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "empty.txt",
            edits: [{ range: ["1a│", "1a│"], lines: ["hello"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/\[E_EMPTY_FILE\]/);
    });
  });

  it("accepts new op shapes while remaining backward-compatible with range", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    // Old-style range replace (backward compat)
    // P4 (edit): op is now required per-edit; the old style had no op
    // because the default was 'replace'. We add it explicitly.
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace", range: ["1a│old", "1a│old"], lines: ["x"] }],
      }),
    ).toBe(true);

    // New: append with pos
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "append", pos: "1a│old", lines: ["new line"] }],
      }),
    ).toBe(true);

    // New: prepend with pos
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "prepend", pos: "1a│old", lines: ["new line"] }],
      }),
    ).toBe(true);

    // New: replace_text
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace_text", oldText: "foo", newText: "bar" }],
      }),
    ).toBe(true);

    // New: append without pos (BOF) — valid
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "append", lines: ["eof line"] }],
      }),
    ).toBe(true);

    // New: prepend without pos (EOF) — valid
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "prepend", lines: ["bof line"] }],
      }),
    ).toBe(true);

    // New: explicit op:"replace" with range
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace", range: ["1a│old", "1a│old"], lines: ["x"] }],
      }),
    ).toBe(true);

    // Invalid shape: replace_text without oldText — passes schema (runtime rejects)
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace_text", newText: "bar" }],
      }),
    ).toBe(true);

    // Invalid shape: append without lines — passes schema (runtime rejects)
    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "append", pos: "1a│old" }],
      }),
    ).toBe(true);
  });

  it("executes append op after the anchored line", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["aaa", "bbb", "ccc"];
        const ref = `2${computePublicLineChecksum(lines, 2)}│bbb`;

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ op: "append", pos: ref, lines: ["XXX"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nXXX\nccc\n");
        expect(result.details?.diff).toContain("+3");
        expect(result.details?.diff).toContain("│XXX");
      },
    );
  });

  it("executes prepend op before the anchored line", async () => {
    await withTempFile(
      "sample.txt",
      "aaa\nbbb\nccc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");
        const lines = ["aaa", "bbb", "ccc"];
        const ref = `2${computePublicLineChecksum(lines, 2)}│bbb`;

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ op: "prepend", pos: ref, lines: ["XXX"] }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe("aaa\nXXX\nbbb\nccc\n");
        expect(result.details?.diff).toContain("+2");
        expect(result.details?.diff).toContain("│XXX");
      },
    );
  });

  it("executes append without pos (EOF insertion)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ op: "append", lines: ["ZZZ"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nZZZ\n");
      expect(result.details?.diff).toContain("+3");
      expect(result.details?.diff).toContain("│ZZZ");
    });
  });

  it("executes prepend without pos (BOF insertion)", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ op: "prepend", lines: ["YYY"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("YYY\naaa\nbbb\n");
      expect(result.details?.diff).toContain("+1");
      expect(result.details?.diff).toContain("│YYY");
    });
  });

  it("executes replace_text op — exact unique substring replacement", async () => {
    await withTempFile(
      "sample.txt",
      "const answer = 42;\nconsole.log(answer);\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ op: "replace_text", oldText: "42", newText: "99" }],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(await readFile(path, "utf-8")).toBe(
          "const answer = 99;\nconsole.log(answer);\n",
        );
        expect(result.details?.diff).toContain("│const answer = 42");
        expect(result.details?.diff).toContain("│const answer = 99");
      },
    );
  });

  it("rejects replace_text when oldText occurs multiple times", async () => {
    await withTempFile(
      "sample.txt",
      "foo\nbar\nfoo\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        await expect(
          editTool.execute(
            "e1",
            {
              path: "sample.txt",
              edits: [{ op: "replace_text", oldText: "foo", newText: "baz" }],
            },
            undefined,
            undefined,
            { cwd } as any,
          ),
        ).rejects.toThrow(/E_REPLACE_TEXT_NOT_UNIQUE|multiple occurrences/);
      },
    );
  });

  it("emits W_AUTO_RECOVERY when replace_text matches via byte-level recovery (trailing whitespace)", async () => {
    // File has trailing whitespace on line 1, model sent clean text.
    // The text-level indexOf fails; tryRecovery (exact → LF/CRLF → trimmed) succeeds.
    await withTempFile("ws.txt", "hello   \nworld\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const result = await editTool.execute(
        "e1",
        {
          path: "ws.txt",
          edits: [
            {
              op: "replace_text",
              oldText: "hello\nworld",
              newText: "goodbye\nworld",
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      expect(await readFile(path, "utf-8")).toBe("goodbye\nworld\n");
      const text = result.content?.map((c: any) => c.text).join("") ?? "";
      expect(text).toContain("W_AUTO_RECOVERY");
    });
  });

  it("rejects replace_text when oldText does not occur", async () => {
    await withTempFile("sample.txt", "hello world\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              { op: "replace_text", oldText: "missing", newText: "found" },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/E_REPLACE_TEXT_NOT_FOUND|not found/);
    });
  });
});

describe("registerEditTool — backslash normalization", () => {
  it("backslash-normalizes when file has escaped quotes but model sent bare quotes", async () => {
    await withTempFile(
      "backslash.txt",
      'const path = `@\\"${completionPath}\\"`;\n',
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        registerEditTool(pi);
        const editTool = getTool("edit");

        const result = await editTool.execute(
          "e1",
          {
            path: "backslash.txt",
            edits: [
              {
                op: "replace_text",
                oldText: 'const path = `@"${completionPath}"`;',
                newText: 'const path = "REPLACED";',
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        expect(result.details?.metrics?.classification).toBe("applied");
        const fileContent = await import("node:fs/promises").then((m) =>
          m.readFile(path, "utf-8"),
        );
        expect(fileContent).toContain('const path = "REPLACED"');
      },
    );
  });
});

describe("normalizeEditItems", () => {
  it("maps legacy range-based replace edits", () => {
    const result = normalizeEditItems([
      { range: ["1a│old", "1a│old"], lines: ["x"] },
    ]);
    expect(result).toEqual([
      { op: "replace", pos: "1a│old", end: "1a│old", lines: ["x"] },
    ]);
  });

  it("maps explicit op:'replace' with range", () => {
    const result = normalizeEditItems([
      { op: "replace", range: ["1a│old", "1a│old"], lines: ["x"] },
    ]);
    expect(result).toEqual([
      { op: "replace", pos: "1a│old", end: "1a│old", lines: ["x"] },
    ]);
  });

  it("maps op:'append' with pos", () => {
    const result = normalizeEditItems([
      { op: "append", pos: "2b│bbb", lines: ["new"] },
    ]);
    expect(result).toEqual([{ op: "append", pos: "2b│bbb", lines: ["new"] }]);
  });

  it("maps op:'prepend' with pos", () => {
    const result = normalizeEditItems([
      { op: "prepend", pos: "2b│bbb", lines: ["new"] },
    ]);
    expect(result).toEqual([{ op: "prepend", pos: "2b│bbb", lines: ["new"] }]);
  });

  it("maps op:'append' without pos (EOF)", () => {
    const result = normalizeEditItems([{ op: "append", lines: ["eof line"] }]);
    expect(result).toEqual([{ op: "append", pos: "", lines: ["eof line"] }]);
  });

  it("maps op:'prepend' without pos (BOF)", () => {
    const result = normalizeEditItems([{ op: "prepend", lines: ["bof line"] }]);
    expect(result).toEqual([{ op: "prepend", pos: "", lines: ["bof line"] }]);
  });

  it("maps op:'replace_text' with oldText and newText", () => {
    const result = normalizeEditItems([
      { op: "replace_text", oldText: "foo", newText: "bar" },
    ]);
    expect(result).toEqual([
      { op: "replace_text", pos: "", oldText: "foo", newText: "bar" },
    ]);
  });

  it("defaults missing op to replace with range", () => {
    const result = normalizeEditItems([
      { range: ["1a│old", "1a│old"], lines: ["x"] },
    ]);
    expect(result[0]?.op).toBe("replace");
  });

  it("rejects unknown op values at runtime", () => {
    expect(() => normalizeEditItems([{ op: "delete", pos: "1a│old" }])).toThrow(
      /unsupported op/i,
    );
  });
});

describe("compact ref acceptance", () => {
  it("accepts bare line number '1' through computeEditPreview", async () => {
    await withTempFile("test.ts", "hello\nworld", async ({ cwd, path }) => {
      const preview = await computeEditPreview(
        {
          path: "test.ts",
          edits: [{ op: "replace", range: ["1", "1"], lines: ["HELLO"] }],
        },
        cwd,
      );
      // Should not return an error — compact ref is accepted
      if ("error" in preview) {
        throw new Error(`Unexpected error: ${preview.error}`);
      }
      expect(preview.diff).toContain("hello");
      expect(preview.diff).toContain("HELLO");
    });
  });

  it("accepts LINE#HASH compact ref through computeEditPreview", async () => {
    await withTempFile("test.ts", "hello\nworld", async ({ cwd, path }) => {
      const fileLines = "hello\nworld".split("\n");
      const hash = computeLineHash(fileLines, 0);
      const ref = `1#${hash}`;
      const preview = await computeEditPreview(
        {
          path: "test.ts",
          edits: [{ op: "replace", range: [ref, ref], lines: ["HELLO"] }],
        },
        cwd,
      );
      if ("error" in preview) {
        throw new Error(`Unexpected error: ${preview.error}`);
      }
      expect(preview.diff).toContain("hello");
      expect(preview.diff).toContain("HELLO");
    });
  });
});

describe("overlapping range detection (F5)", () => {
  it("throws on overlapping replace ranges via preview", async () => {
    await withTempFile(
      "overlap.txt",
      "a\nb\nc\nd\ne\n",
      async ({ cwd, path }) => {
        const preview = await computeEditPreview(
          {
            path: "overlap.txt",
            edits: [
              { op: "replace", range: ["1", "3"], lines: ["X", "Y"] },
              { op: "replace", range: ["2", "4"], lines: ["Z"] },
            ],
          },
          cwd,
        );
        expect(preview).toHaveProperty("error");
        if ("error" in preview) {
          expect(preview.error).toMatch(/\[E_EDIT_CONFLICT\]/);
        }
      },
    );
  });

  it("throws on adjacent-but-disjoint ranges (not overlap)", async () => {
    await withTempFile(
      "adjacent.txt",
      "a\nb\nc\nd\ne\n",
      async ({ cwd, path }) => {
        const preview = await computeEditPreview(
          {
            path: "adjacent.txt",
            edits: [
              { op: "replace", range: ["1", "2"], lines: ["X"] },
              { op: "replace", range: ["3", "4"], lines: ["Y"] },
            ],
          },
          cwd,
        );
        // Adjacent but not overlapping should succeed
        expect(preview).not.toHaveProperty("error");
        if (!("error" in preview)) {
          expect(preview.diff).toBeTruthy();
        }
      },
    );
  });

  it("throws on fully contained overlap", async () => {
    await withTempFile(
      "contained.txt",
      "a\nb\nc\nd\ne\nf\n",
      async ({ cwd, path }) => {
        const preview = await computeEditPreview(
          {
            path: "contained.txt",
            edits: [
              { op: "replace", range: ["1", "6"], lines: ["BIG"] },
              { op: "replace", range: ["2", "3"], lines: ["small"] },
            ],
          },
          cwd,
        );
        expect(preview).toHaveProperty("error");
        if ("error" in preview) {
          expect(preview.error).toMatch(/\[E_EDIT_CONFLICT\]/);
        }
      },
    );
  });

  it("allows replace_text alongside range edits with no overlap", async () => {
    await withTempFile("mixed-ops.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const preview = await computeEditPreview(
        {
          path: "mixed-ops.txt",
          edits: [
            { op: "replace_text", oldText: "b", newText: "B" },
            { op: "replace", range: ["3", "3"], lines: ["C"] },
          ],
        },
        cwd,
      );
      // replace_text doesn't have a range, so no overlap possible
      expect(preview).not.toHaveProperty("error");
    });
  });
});
