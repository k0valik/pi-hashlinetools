import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { hashlineEditToolSchema } from "../../src/edit";
import { makeFakePiRegistry } from "../support/fixtures";

const PKG_ROOT = join(__dirname, "..", "..");

/**
 *   +  tool descriptions are happy-path only.
 *
 * No "what NOT to do" lists. No `W_*` / `E_*` code names. No "be careful
 * not to" warnings. No "Split large changes" (the whole point of
 * multi-edit + dry-run is to batch).
 *
 * "Common mistakes" is collapsed to a short instructional summary.
 * Tool names are backticked.
 *
 * The rationale: the model can't reason about failure modes. Listing
 * them doesn't help. The tool already emits warnings; the description
 * describes the happy path.
 */
describe("tool descriptions are happy-path only ", () => {
  describe("edit.md", () => {
    const content = readFileSync(
      join(PKG_ROOT, "tool-descriptions", "edit.md"),
      "utf-8",
    );

    it("does not contain 'Split large changes' (D6)", () => {
      expect(content).not.toContain("Split large changes");
    });

    it("does not contain 'prefer separate' (D6)", () => {
      expect(content).not.toContain("prefer separate");
    });

    it("does not contain W_* or E_* error/warning code names in the description (D2)", () => {
      // Strip code blocks / examples to keep this narrow; we only assert
      // on prose. The current tool descriptions don't put codes in
      // code blocks, so a plain not-contains works.
      expect(content).not.toMatch(/W_[A-Z_]+/);
      expect(content).not.toMatch(/E_[A-Z_]+/);
    });

    it("'Common mistakes' is gone or collapsed to a short note (D2)", () => {
      // Either the section header is gone, or it's been collapsed to
      // a short paragraph (not a multi-bullet list).
      const hasHeader = content.includes("### Common mistakes");
      if (hasHeader) {
        // If the header still exists, the body under it must be short
        // (≤ ~3 lines) and instructional, not a bullet list of "do not".
        const after = content.split("### Common mistakes")[1] ?? "";
        // Reject bullet-list format under "Common mistakes".
        expect(after).not.toMatch(/^- \*\*/m);
      } else {
        // Even better: the header is gone.
        expect(hasHeader).toBe(false);
      }
    });

    it("backticks `read`, `write`, `undo` when referenced (D2)", () => {
      // Sample checks — the description references these tools.
      // Note: `edit` is the description's own tool, so the description
      // does not need to self-reference. The "backtick when referenced"
      // rule applies only to cross-references to other tools.
      expect(content).toContain("`read`");
      expect(content).toContain("`undo`");
    });

    it("leads with `replace_text` so the model defaults to the safer op (P1.1)", () => {
      // P1.1: order ops in the description so the first one the
      // model reads is `replace_text` — it has byte-level recovery
      // via tryRecovery (grafted from pi-robust-edit) and doesn't
      // require anchor construction, eliminating the entire
      // `edits.0.range.1: must be string` class of AJV errors.
      const replaceTextIdx = content.indexOf("**`replace_text`**");
      const replaceIdx = content.indexOf("**`replace`**");
      expect(replaceTextIdx).toBeGreaterThan(-1);
      expect(replaceIdx).toBeGreaterThan(-1);
      expect(replaceTextIdx).toBeLessThan(replaceIdx);
    });

    it("the `replace` description points at `replace_text` for whole-block rewrites (P1.1)", () => {
      // After the `replace` op block, the description should mention
      // `replace_text` as the simpler alternative for whole-block
      // rewrites. This is the soft steer — the lead-ordering is the
      // strong signal, this is the explicit fallback.
      const replaceIdx = content.indexOf("**`replace`**");
      const replaceTextIdx = content.indexOf("`replace_text`");
      // Find the second occurrence of `replace_text` (first is in the
      // replace_text op block; we want the one in the replace op block).
      const secondOccurrence = content.indexOf(
        "`replace_text`",
        replaceTextIdx + 1,
      );
      expect(replaceIdx).toBeGreaterThan(-1);
      expect(secondOccurrence).toBeGreaterThan(replaceIdx);
    });

    it("does not include raw JSON code blocks duplicating the schema (P4)", () => {
      // Per docs/pi-system-prompt-architecture.md, the description is
      // for "full user-facing docs" (purpose, when to use, common
      // mistakes), NOT for re-stating the schema. JSON code blocks in
      // the description duplicate the schema structure. Same cleanup
      // as inspect_text (P4).
      expect(content).not.toMatch(/```json/);
    });

    it("does not leak the discriminator name or default (P4)", () => {
      // The "op" field and its default value are architecture. The
      // schema already says op is required per-edit. The description
      // should not mention the field name or its default.
      expect(content).not.toMatch(/`?op`? field/);
      expect(content).not.toMatch(/defaults to/i);
    });
  });

  describe("edit-snippet.md", () => {
    const content = readFileSync(
      join(PKG_ROOT, "tool-descriptions", "edit-snippet.md"),
      "utf-8",
    );

    it("is a single-line snippet (D2)", () => {
      expect(
        content.split("\n").filter((l) => l.trim()).length,
      ).toBeLessThanOrEqual(2);
    });

    it("does not contain 'prefer separate' (D6)", () => {
      expect(content).not.toContain("prefer separate");
    });

    it("does not contain 'Split large changes' (D6)", () => {
      expect(content).not.toContain("Split large changes");
    });

    it("mentions `replace_text` in the snippet (P1.1)", () => {
      // P1.1: the snippet is what gets injected into the system prompt.
      // It must list `replace_text` so the model knows the op exists
      // without expanding the full description.
      expect(content).toContain("`replace_text`");
    });

    it("leads with `replace_text` before `replace` in the snippet (P1.1)", () => {
      // The snippet should order ops: replace_text, append/prepend,
      // replace. The first op listed in the snippet is the one the
      // model is most likely to use.
      const replaceTextIdx = content.indexOf("`replace_text`");
      const replaceIdx = content.indexOf("`replace`");
      expect(replaceTextIdx).toBeGreaterThan(-1);
      expect(replaceIdx).toBeGreaterThan(-1);
      expect(replaceTextIdx).toBeLessThan(replaceIdx);
    });
  });

  describe("read.md", () => {
    const content = readFileSync(
      join(PKG_ROOT, "tool-descriptions", "read.md"),
      "utf-8",
    );

    it("does not mention `raw: true` (the parameter was renamed to `plain` in D4)", () => {
      expect(content).not.toContain("raw: true");
      expect(content).not.toContain("`raw`");
    });

    it("does not contain W_* or E_* code names in the description (D2)", () => {
      expect(content).not.toMatch(/W_[A-Z_]+/);
      expect(content).not.toMatch(/E_[A-Z_]+/);
    });
  });

  describe("undo.md", () => {
    const content = readFileSync(
      join(PKG_ROOT, "tool-descriptions", "undo.md"),
      "utf-8",
    );

    it("is a single-line description (D3)", () => {
      expect(content.split("\n").filter((l) => l.trim()).length).toBe(1);
    });

    it("does not contain a 'Limitations' sub-bullets section (D3)", () => {
      expect(content).not.toContain("Limitations");
    });
  });

  describe("AJV edits field description in edit.ts", () => {
    it("does not contain 'Split large changes' (D6)", () => {
      // hashlineEditToolSchema has the description; pull the JSON
      // schema and check the `edits` field description.
      const json = hashlineEditToolSchema as unknown as {
        properties: {
          edits: { description: string };
        };
      };
      expect(json.properties.edits.description).not.toContain(
        "Split large changes",
      );
    });
  });

  describe("AJV per-edit op field is REQUIRED (P4 edit)", () => {
    // P4 (edit): the per-edit `op` field used to default to 'replace'
    // when omitted. This was a permissive-schema anti-pattern: a model
    // sending `{pos: "...", lines: [...]}` (intending `append` but
    // forgetting `op`) would get implicit `replace` and a confusing
    // downstream error.
    //
    // New behavior: the per-edit `op` is REQUIRED. AJV rejects the
    // call at the host boundary with a clear "missing required field:
    // op" error. The runtime keeps its `|| "replace"` default as a
    // defense-in-depth safety net for callers that bypass AJV (tests,
    // direct API calls) — but in the normal model→host→execute path,
    // AJV catches the missing op first.
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    it("AJV accepts a replace entry with explicit op: 'replace'", () => {
      expect(
        validate({
          path: "a.ts",
          edits: [
            {
              op: "replace",
              range: ["1a│old", "1a│old"],
              lines: ["new"],
            },
          ],
        }),
      ).toBe(true);
    });

    it("AJV accepts an append entry with explicit op: 'append'", () => {
      expect(
        validate({
          path: "a.ts",
          edits: [
            {
              op: "append",
              pos: "1a│anchor",
              lines: ["new"],
            },
          ],
        }),
      ).toBe(true);
    });

    it("AJV accepts a replace_text entry with explicit op: 'replace_text'", () => {
      expect(
        validate({
          path: "a.ts",
          edits: [
            {
              op: "replace_text",
              oldText: "oldFunction()",
              newText: "newFunction()",
            },
          ],
        }),
      ).toBe(true);
    });

    it("AJV REJECTS a replace entry without op (the misconception failure mode)", () => {
      // The model intended `replace` (no op needed before) but sent
      // the same shape it would have sent for any op. AJV now
      // catches this at the host boundary.
      const valid = validate({
        path: "a.ts",
        edits: [{ range: ["1a│old", "1a│old"], lines: ["new"] }],
      });
      expect(valid).toBe(false);
    });

    it("AJV REJECTS an append entry without op (the actual misconception case)", () => {
      // The model intended `append` but forgot to specify op. It sent
      // `pos` and `lines` thinking those would be enough. With the
      // old default-op behavior, the runtime would treat this as
      // `replace` and choke on the unknown `pos` field. With required
      // op, AJV rejects at the host with a clear error.
      const valid = validate({
        path: "a.ts",
        edits: [{ pos: "1a│anchor", lines: ["new"] }],
      });
      expect(valid).toBe(false);
    });

    it("AJV REJECTS a replace_text entry without op", () => {
      const valid = validate({
        path: "a.ts",
        edits: [{ oldText: "oldFunction()", newText: "newFunction()" }],
      });
      expect(valid).toBe(false);
    });

    it("AJV REJECTS an entry with an unknown op", () => {
      const valid = validate({
        path: "a.ts",
        edits: [{ op: "garbage", range: ["1a│old", "1a│old"], lines: ["new"] }],
      });
      expect(valid).toBe(false);
    });

    it("AJV still accepts a full envelope with multiple entries of different ops", () => {
      // Regression check: tightening the schema must not break valid
      // multi-edit batches.
      expect(
        validate({
          path: "a.ts",
          edits: [
            { op: "replace", range: ["1a│old", "1a│old"], lines: ["new"] },
            { op: "append", pos: "2a│anchor", lines: ["x"] },
            {
              op: "replace_text",
              oldText: "foo",
              newText: "bar",
            },
          ],
        }),
      ).toBe(true);
    });
  });

  describe("registered tool descriptions match the on-disk files (D2)", () => {
    it("the registered edit tool's description matches edit.md", () => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const onDisk = readFileSync(
        join(PKG_ROOT, "tool-descriptions", "edit.md"),
        "utf-8",
      ).trim();
      expect(editTool.description).toBe(onDisk);
    });

    it("the registered read tool's description matches read.md", () => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const onDisk = readFileSync(
        join(PKG_ROOT, "tool-descriptions", "read.md"),
        "utf-8",
      )
        .replaceAll("{{DEFAULT_MAX_LINES}}", "2000")
        .replaceAll("{{DEFAULT_MAX_BYTES}}", "50.0KB")
        .trim();
      expect(readTool.description).toBe(onDisk);
    });

    it("the registered undo tool's description matches undo.md (one-liner)", () => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const undoTool = getTool("undo");
      const onDisk = readFileSync(
        join(PKG_ROOT, "tool-descriptions", "undo.md"),
        "utf-8",
      ).trim();
      expect(undoTool.description).toBe(onDisk);
    });
  });
});
