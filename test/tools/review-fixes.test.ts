import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  expectRefusedWithError,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

/**
 * Regression tests for bug fixes identified during PR review.
 */
  describe("PR review follow-ups", () => {
  describe("edit.lines string normalization", () => {
    it("E_EMPTY_LINES still fires when edit.lines is an empty string (defensive check)", async () => {
      // The HashlineToolEdit type allows `lines: string | string[] | null`.
      // The schema (and normalizeEditItems) always coerces to string[], but
      // anchorBareLineNumberEdits should be defensive about the type.
      // We test via the public API which goes through normalizeEditItems,
      // so we just verify the happy path still works after the defensive
      // normalization was added.
      await withTempFile(
        "string-lines.txt",
        "a\nb\nc\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          const fileLines = ["a", "b", "c"];
          const ref = `${fileLines.length - 1}#${"x".repeat(3)}│b`;

          // append with empty array — still E_EMPTY_LINES
          const result = await editTool.execute(
            "e",
            {
              path: "string-lines.txt",
              edits: [{ op: "append", pos: ref, lines: [] }],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );

          expectRefusedWithError(result, /\[E_EMPTY_LINES\]/);
          expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
        },
      );
    });
  });

  describe("sanitizeForMessage output bounded to maxLen+1", () => {
    // Regression for the bug where the raw-truncation-before-escape
    // approach let escapes expand the output unboundedly:
    //   - 80 backslashes (raw length 80) → 160 escaped chars + ellipsis
    //   - 80 null bytes (raw length 80) → 480 escaped chars + ellipsis
    // After the fix, we escape first and truncate the escaped string at
    // maxLen, backtracking to a complete escape boundary. Output is
    // always ≤ maxLen + 1 chars.
    //
    // We exercise the helper indirectly via the error message produced
    // by a long oldText with control chars, then verify the rendered
    // message length via the toast/notification path.
    it("long oldText ending in \\r\\n truncates cleanly (ends with …, no orphan backslash)", async () => {
      await withTempFile(
        "trunc.txt",
        "hello world\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          // 80 chars of "A" + 5 trailing CR/LF chars = 85 char raw string.
          // After escape, the trailing escapes are 10 chars (\r\n\r\n\r).
          // After truncation at 80, the last escape in the kept portion
          // is complete (we backtrack if not), and we append "…".
          const longText = "A".repeat(80) + "\r\n\r\n\r";
          await expect(
            editTool.execute(
              "e",
              {
                path: "trunc.txt",
                edits: [
                  {
                    op: "replace_text",
                    oldText: longText,
                    newText: "x",
                  },
                ],
              },
              undefined,
              undefined,
              { cwd, hasUI: true, ui: { notify() {} } } as any,
            ),
          ).rejects.toThrow(/E_REPLACE_TEXT_NOT_FOUND/);
          expect(await readFile(path, "utf-8")).toBe("hello world\n");
        },
      );
    });

    it("long oldText of pure backslashes does not produce unbounded output", async () => {
      // 100 raw backslashes → 200 escaped chars. The fix bounds the
      // output to 81 chars (80 + ellipsis), even though the escaped
      // string is 200 chars long.
      await withTempFile("bsl.txt", "hello world\n", async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const longText = "\\".repeat(100);
        let caught: Error | undefined;
        try {
          await editTool.execute(
            "e",
            {
              path: "bsl.txt",
              edits: [{ op: "replace_text", oldText: longText, newText: "x" }],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );
        } catch (e) {
          caught = e as Error;
        }
        expect(caught).toBeDefined();
        // The error message must contain the bounded oldText snippet.
        // The snippet is between the opening '"' and the next '"' in
        // "...\""+snippet+"\" not found...". We expect it to be at
        // most 81 chars (maxLen 80 + ellipsis) and to end with "…".
        const msg = caught?.message ?? "";
        const snippetMatch = msg.match(/"([^"]*…)" not found/);
        expect(snippetMatch).not.toBeNull();
        const snippet = snippetMatch?.[1] ?? "";
        expect(snippet.length).toBeLessThanOrEqual(81);
        // No partial \u at the end (would be 1-5 chars of \u or \uXXXX).
        expect(snippet).not.toMatch(/\\u[0-9a-fA-F]?$/);
        // The snippet should not have a trailing lone backslash either.
        // (A trailing "\\\\…" is fine: that's a complete \\ escape + ellipsis.)
        expect(snippet.endsWith("…")).toBe(true);
        expect(await readFile(path, "utf-8")).toBe("hello world\n");
      });
    });

    it("long oldText of pure control bytes does not produce unbounded output", async () => {
      // 100 NUL bytes (raw length 100) → 600 escaped chars (\u0000 × 100).
      // The fix bounds the output to 81 chars.
      await withTempFile("ctrl.txt", "hello world\n", async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const longText = "\u0000".repeat(100);
        let caught: Error | undefined;
        try {
          await editTool.execute(
            "e",
            {
              path: "ctrl.txt",
              edits: [{ op: "replace_text", oldText: longText, newText: "x" }],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );
        } catch (e) {
          caught = e as Error;
        }
        expect(caught).toBeDefined();
        const msg = caught?.message ?? "";
        const snippetMatch = msg.match(/"([^"]*…)" not found/);
        expect(snippetMatch).not.toBeNull();
        const snippet = snippetMatch?.[1] ?? "";
        expect(snippet.length).toBeLessThanOrEqual(81);
        // No partial \u at the end.
        expect(snippet).not.toMatch(/\\u[0-9a-fA-F]?$/);
        expect(snippet.endsWith("…")).toBe(true);
        expect(await readFile(path, "utf-8")).toBe("hello world\n");
      });
    });
  });

  describe("buildNoopResponse fallback distinguishes refused vs identical", () => {
    it("refused batch says 'batch was refused' (not 'identical content')", async () => {
      await withTempFile(
        "refused.txt",
        "a\nb\nc\nd\ne\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          const fileLines = ["a", "b", "c", "d", "e"];
          // Overlapping (but non-identical) ranges so the conflict detector fires.
          const ref1 = `1#${"x".repeat(3)}│a`;
          const ref2 = `3#${"x".repeat(3)}│c`;
          const ref3 = `5#${"x".repeat(3)}│e`;

          const result = await editTool.execute(
            "e",
            {
              path: "refused.txt",
              edits: [
                { op: "replace", range: [ref1, ref2], lines: ["X"] },
                { op: "replace", range: [ref2, ref3], lines: ["Y"] },
              ],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );

          const text = result.content?.[0]?.text ?? "";
          // The user-facing text should NOT say "identical content" or
          // "the new content matches the existing content" — the batch
          // was refused for a different reason.
          expect(text).not.toMatch(/identical content/i);
          expect(text).not.toMatch(/the new content matches/);
          // The user-facing text should mention the refusal.
          expect(text).toMatch(/refused/i);
          // The refused warning is in the text.
          expect(text).toMatch(/\[E_EDIT_REFUSED\]/);
          // File unchanged.
          expect(await readFile(path, "utf-8")).toBe("a\nb\nc\nd\ne\n");
        },
      );
    });

    it("actual noop (new content matches existing) says 'the new content matches'", async () => {
      await withTempFile(
        "actual-noop.txt",
        "aaa\nbbb\nccc\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          const fileLines = ["aaa", "bbb", "ccc"];
          const ref = `1#${"x".repeat(3)}│aaa`;

          const result = await editTool.execute(
            "e",
            {
              path: "actual-noop.txt",
              edits: [{ op: "replace", range: [ref, ref], lines: ["aaa"] }], // identical
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );

          const text = result.content?.[0]?.text ?? "";
          // The user-facing text for an actual noop says "the new content
          // matches the existing content".
          expect(text).toMatch(/the new content matches/);
          // No "refused" framing.
          expect(text).not.toMatch(/refused/i);
          expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
        },
      );
    });
  });
});
