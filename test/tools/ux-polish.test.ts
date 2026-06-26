import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  expectRefusedWithError,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

/**
 * Regression tests for the UX polish + architecture-leak cleanup
 * applied on top of feature/hashline-wire-recovery.
 *
 * 1. `append`/`prepend` with empty `lines: []` → E_EMPTY_LINES (was
 *    a confusing "replacement for N#XXX is identical to current
 *    content" message before the fix; FIRST §6.5 / SECOND §5.4).
 * 2. The noop response text no longer contains "Classification: noop"
 *    (was leaking the internal classification metric; user-facing UX).
 * 3. CRLF and other control characters in `oldText` are rendered as
 *    escape sequences in error messages (was rendering raw CR/LF in
 *    the message text; SECOND §5.7).
 */
describe("UX polish + architecture-leak cleanup (stacked on wire-recovery)", () => {
  describe("append/prepend with empty lines → E_EMPTY_LINES (FIRST §6.5 / SECOND §5.4)", () => {
    it("append with empty lines: returns a clear E_EMPTY_LINES, not a confusing noop message", async () => {
      await withTempFile(
        "empty-append.txt",
        "a\nb\nc\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          const fileLines = ["a", "b", "c"];
          const ref = `${fileLines.length - 1}#${"x".repeat(3)}│b`;

          const result = await editTool.execute(
            "e",
            {
              path: "empty-append.txt",
              edits: [{ op: "append", pos: ref, lines: [] }],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );

          expectRefusedWithError(result, /\[E_EMPTY_LINES\]/);
          // The old confusing message referenced an unrelated line number.
          // Make sure that doesn't appear anymore.
          const text = result.content?.[0]?.text ?? "";
          expect(text).not.toMatch(/replacement for.*identical/);
          // File is unchanged.
          expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
        },
      );
    });

    it("prepend with empty lines: returns a clear E_EMPTY_LINES", async () => {
      await withTempFile(
        "empty-prepend.txt",
        "a\nb\nc\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          const lines = ["a", "b", "c"];
          const ref = `2#${"x".repeat(3)}│b`;

          const result = await editTool.execute(
            "e",
            {
              path: "empty-prepend.txt",
              edits: [{ op: "prepend", pos: ref, lines: [] }],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );

          expectRefusedWithError(result, /\[E_EMPTY_LINES\]/);
          const text = result.content?.[0]?.text ?? "";
          expect(text).not.toMatch(/replacement for.*identical/);
          expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
        },
      );
    });
  });

  describe("noop response no longer leaks 'Classification: noop' (UX cleanup)", () => {
    it("the noop text describes the situation in plain language", async () => {
      await withTempFile(
        "noop-clean.txt",
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
              path: "noop-clean.txt",
              edits: [{ op: "replace", range: [ref, ref], lines: ["aaa"] }], // identical
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );

          const text = result.content?.[0]?.text ?? "";
          // Internal classification metric is gone from the user-facing text.
          expect(text).not.toContain("Classification:");
          // Plain-language explanation.
          expect(text).toMatch(/No changes made to/);
          expect(text).toMatch(/the new content matches/);
          // The internal classification still lives in details.classification
          // for tooling.
          expect(result.details?.classification).toBe("noop");
          // File is unchanged.
          expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
        },
      );
    });
  });

  describe("CRLF/control chars in oldText are sanitized in error messages (SECOND §5.7)", () => {
    it("control characters in oldText are rendered as escape sequences in E_REPLACE_TEXT_NOT_FOUND", async () => {
      await withTempFile(
        "crlf-err.txt",
        "hello world\n",
        async ({ cwd, path }) => {
          const { pi, getTool } = makeFakePiRegistry();
          register(pi);
          const editTool = getTool("edit");
          // oldText contains an actual \r\n — the error message should
          // display it as the escape sequence "\r\n", not as raw bytes.
          // applyReplaceTextEdits throws for not-found conditions; the
          // test asserts the throw's message is sanitized.
          await expect(
            editTool.execute(
              "e",
              {
                path: "crlf-err.txt",
                edits: [
                  {
                    op: "replace_text",
                    oldText: "CRLF target\r\n",
                    newText: "anything",
                  },
                ],
              },
              undefined,
              undefined,
              { cwd, hasUI: true, ui: { notify() {} } } as any,
            ),
          ).rejects.toThrow(/E_REPLACE_TEXT_NOT_FOUND.*\\r\\n/s);
          // Sanity: the file was not changed.
          expect(await readFile(path, "utf-8")).toBe("hello world\n");
        },
      );
    });
  });
});
