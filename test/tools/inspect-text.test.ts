/**
 *  stage 2 — `inspect_text` tool.
 *
 * Three ops: `show`, `validate`, `diff`. Replaces the standalone
 * `robust_edit_show`, `robust_edit_validate`, `robust_edit_diff`
 * tools from `pi-robust-edit`. The new tool is a top-level entity
 * (not a sub-tool of `edit`) and uses the same `op` field pattern
 * as the `edit` tool.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("inspect_text tool registration ( stage 2)", () => {
  it("registers a tool named 'inspect_text'", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("inspect_text");
  });

  it("the parameters schema accepts op ∈ {show, validate, diff}", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    const schema = tool.parameters as Record<string, unknown>;
    expect(schema).toBeDefined();
    // The schema is a TypeBox object with an `op` field of type string
    // and one of the three known values. We don't introspect the
    // discriminator (TypeBox metadata varies); we just confirm the
    // schema exists and has the `op` key.
    expect(JSON.stringify(schema)).toContain("op");
  });

  it("carries a short happy-path description (no internal architecture leaks)", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    const desc = (tool.description as string) ?? "";
    expect(desc.length).toBeGreaterThan(0);
    // The description should be short — under 600 chars. This is a
    // sanity check that the description didn't grow into a wall of
    // text like the old robust_edit tool's description.
    expect(desc.length).toBeLessThan(600);
  });

  it("description does NOT include raw JSON code blocks duplicating the schema (P4)", () => {
    // Per docs/pi-system-prompt-architecture.md, the description is for
    // "full user-facing docs" (purpose, when to use, common mistakes),
    // NOT for re-stating the schema. The schema itself carries the
    // syntax. JSON code blocks in the description duplicate the
    // schema structure and bloat the tool block.
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    const desc = (tool.description as string) ?? "";
    expect(desc).not.toMatch(/```json/);
  });
});

describe("inspect_text schema validates strictly per op (P4)", () => {
  // The previous design had every parameter as optional, with runtime
  // checks throwing [E_INSPECT_*_MISSING_*] errors. That made the
  // tool permissive at the schema level and pushed validation into
  // the runtime. Same anti-pattern we just fixed in `edit`.
  //
  // New design: Type.Union with Type.Literal discriminators. AJV
  // validates strictly per op. The runtime no longer needs to check
  // for missing required fields — the schema has already enforced
  // them.

  function getValidator() {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    const ajv = new Ajv({ allErrors: true });
    return ajv.compile(tool.parameters as any);
  }

  it("AJV accepts valid show input", () => {
    const validate = getValidator();
    expect(validate({ op: "show", file: "/tmp/x" })).toBe(true);
  });

  it("AJV accepts valid validate input", () => {
    const validate = getValidator();
    expect(
      validate({ op: "validate", file: "/tmp/x", oldText: "needle" }),
    ).toBe(true);
  });

  it("AJV accepts valid diff input", () => {
    const validate = getValidator();
    expect(validate({ op: "diff", fileA: "/tmp/a", fileB: "/tmp/b" })).toBe(
      true,
    );
  });

  it("AJV rejects show without file", () => {
    const validate = getValidator();
    expect(validate({ op: "show" })).toBe(false);
  });

  it("AJV rejects validate without file", () => {
    const validate = getValidator();
    expect(validate({ op: "validate", oldText: "x" })).toBe(false);
  });

  it("AJV rejects validate without oldText", () => {
    const validate = getValidator();
    expect(validate({ op: "validate", file: "/tmp/x" })).toBe(false);
  });

  it("AJV rejects diff with only fileA", () => {
    const validate = getValidator();
    expect(validate({ op: "diff", fileA: "/tmp/a" })).toBe(false);
  });

  it("AJV rejects diff with only fileB", () => {
    const validate = getValidator();
    expect(validate({ op: "diff", fileB: "/tmp/b" })).toBe(false);
  });

  it("AJV rejects unknown op", () => {
    const validate = getValidator();
    expect(validate({ op: "garbage", file: "/tmp/x" })).toBe(false);
  });

  it("AJV rejects input with no op at all", () => {
    // The op field is now REQUIRED (no default "show"). The model
    // must specify the op explicitly. This is a small behavioral
    // change but a big win in validation strictness.
    const validate = getValidator();
    expect(validate({ file: "/tmp/x" })).toBe(false);
  });
});

describe("inspect_text op: show ( stage 2)", () => {
  it("returns line-numbered content for a small text file", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "show", file: path },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      // Line numbers visible. The format is hashline-anchored
      // (e.g. "1XYt │ alpha") so the model can use the result as
      // anchors for `edit` calls. We assert the digit prefix and
      // the line content.
      expect(text).toMatch(/1[A-Za-z0-9_-]*\s*[│|].*alpha/);
      expect(text).toMatch(/2[A-Za-z0-9_-]*\s*[│|].*beta/);
      expect(text).toMatch(/3[A-Za-z0-9_-]*\s*[│|].*gamma/);
    });
  });

  it("returns a hex preview column for each line", async () => {
    const content = "alpha\nbeta\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "show", file: path },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      // The hex preview of "alpha" is 61 6c 70 68 61.
      expect(text).toContain("61 6c 70 68 61");
    });
  });
  it("resolves relative paths against cwd, not the process CWD", async () => {
    // Place a file in a temp directory, then run the tool with cwd set to that directory and a
    // relative path. The tool must read the file via resolveToCwd, not via the process CWD.
    //
    const content = "alpha\nbeta\n";
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-cwd-"));
    const filePath = join(cwd, "x.txt");
    await writeFile(filePath, content, "utf-8");
    try {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "show", file: "x.txt" },
        new AbortController().signal,
        () => {},
        { cwd },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("inspect_text op: validate ( stage 2)", () => {
  it("reports a unique 1-match on exact substring", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "validate", file: path, oldText: "beta" },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      expect(result.isError).toBeFalsy();
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      // Reports 1 match
      expect(text).toMatch(/1 (match|occurrence|time)/i);
      // Includes the line number where the match is
      expect(text).toMatch(/lines? 2/);
    });
  });

  it("reports a 0-match with a clear message", async () => {
    const content = "alpha\nbeta\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "validate", file: path, oldText: "delta" },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text.toLowerCase()).toMatch(/not found|0 match|0 occurrence/);
    });
  });

  it("silently recovers from trailing whitespace via the same byte-level strategies as replace_text", async () => {
    // File has trailing space on line 1; oldText does not. The file has 0 exact matches
    // (because the byte sequence differs), but `tryRecovery` finds a unique match starting at
    // line 1. We assert both the "1 match" report and the correct line number. The bug we fixed:
    // the count was derived from the spliced buffer (which happened to contain oldText when
    // newText === oldText, masking the bug). Now we count from `recovery.matchPosition` directly.
    //
    // The file has a trailing space; oldText does not. validate
    // should report "1 match" with a hint that whitespace tolerance
    // was applied, not "0 matches".
    const content = "line1 \nline2\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "validate", file: path, oldText: "line1\nline2" },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text).toMatch(/1 (match|occurrence|time)/i);
      // Hint about tolerance (not a hard error)
      expect(text.toLowerCase()).toMatch(/tolerance|whitespace|line-ending/);
      // Line number is computed from recovery.matchPosition, not from the spliced buffer.
      expect(text).toMatch(/Match locations:\s*lines?\s*1\b/);
    });
  });
});

describe("inspect_text op: diff ( stage 2)", () => {
  it("reports identical files as such", async () => {
    const content = "alpha\nbeta\n";
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
    const fileA = join(cwd, "a.txt");
    const fileB = join(cwd, "b.txt");
    await writeFile(fileA, content, "utf-8");
    await writeFile(fileB, content, "utf-8");
    try {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "diff", fileA, fileB },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text.toLowerCase()).toMatch(/identical|equal/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports differences for two distinct files", async () => {
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
    const fileA = join(cwd, "a.txt");
    const fileB = join(cwd, "b.txt");
    await writeFile(fileA, "alpha\nbeta\n", "utf-8");
    await writeFile(fileB, "alpha\nBETA\n", "utf-8");
    try {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "diff", fileA, fileB },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      // Should mention the changed line, not be "identical"
      expect(text.toLowerCase()).not.toMatch(/^\s*identical/);
      expect(text).toMatch(/beta|BETA/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("inspect_text defense-in-depth runtime guards (kilo review fix)", () => {
  // The P4 commit removed explicit [E_INSPECT_SHOW_MISSING_FILE],
  // [E_INSPECT_VALIDATE_MISSING_FILE/OLDTEXT], and
  // [E_INSPECT_DIFF_MISSING_FILES] runtime checks, saying "AJV has
  // done that work." But this is inconsistent with the same PR's
  // edit.ts change, which explicitly kept the `|| "replace"`
  // default in normalizeEditItems as defense-in-depth for direct
  // callers that bypass AJV (tests, scripts, host bugs).
  //
  // Without these guards, a direct caller passing
  //   { op: "validate" }  (no oldText)
  // silently coerces undefined to the literal string "undefined"
  // via countMatches(), then crashes in renderValidate with an
  // uncaught TypeError. Same for { op: "show" } without file
  // (resolveToCwd → expandPath → filePath.startsWith → TypeError).
  //
  // These tests call execute() directly, bypassing AJV, to verify
  // the runtime guards fire with the proper [E_*] error codes.

  function makeCtx() {
    return { cwd: process.cwd() };
  }

  it("show: missing file param throws [E_INSPECT_SHOW_MISSING_FILE]", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    // Cast to any to bypass the type system's narrowing of the union.
    await expect(
      tool.execute(
        "tc1",
        { op: "show" } as any,
        new AbortController().signal,
        () => {},
        makeCtx(),
      ),
    ).rejects.toThrow(/\[E_INSPECT_SHOW_MISSING_FILE\]/);
  });

  it("validate: missing file param throws [E_INSPECT_VALIDATE_MISSING_FILE]", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    await expect(
      tool.execute(
        "tc1",
        { op: "validate", oldText: "foo" } as any,
        new AbortController().signal,
        () => {},
        makeCtx(),
      ),
    ).rejects.toThrow(/\[E_INSPECT_VALIDATE_MISSING_FILE\]/);
  });

  it("validate: missing oldText param throws [E_INSPECT_VALIDATE_MISSING_OLDTEXT]", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    await expect(
      tool.execute(
        "tc1",
        { op: "validate", file: "/tmp/anything" } as any,
        new AbortController().signal,
        () => {},
        makeCtx(),
      ),
    ).rejects.toThrow(/\[E_INSPECT_VALIDATE_MISSING_OLDTEXT\]/);
  });

  it("diff: missing fileA param throws [E_INSPECT_DIFF_MISSING_FILES]", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    await expect(
      tool.execute(
        "tc1",
        { op: "diff", fileB: "/tmp/anything" } as any,
        new AbortController().signal,
        () => {},
        makeCtx(),
      ),
    ).rejects.toThrow(/\[E_INSPECT_DIFF_MISSING_FILES\]/);
  });

  it("diff: missing fileB param throws [E_INSPECT_DIFF_MISSING_FILES]", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const tool = getTool("inspect_text");
    await expect(
      tool.execute(
        "tc1",
        { op: "diff", fileA: "/tmp/anything" } as any,
        new AbortController().signal,
        () => {},
        makeCtx(),
      ),
    ).rejects.toThrow(/\[E_INSPECT_DIFF_MISSING_FILES\]/);
  });
});
