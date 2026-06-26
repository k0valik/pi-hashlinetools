import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

/**
 * Regression tests derived from the two stress test reports:
 * - docs/FIRST_CONTAMINATED_STRESS_TEST.md
 * - docs/SECOND-stress-test-report.md
 *
 * The stress test was run by an external agent with no knowledge of the
 * implementation, so the findings reflect what the user actually sees.
 */
describe("stress report regressions", () => {
  describe("BOM preservation (FIRST §1.2, SECOND §6 BUG 1)", () => {
    it("preserves UTF-8 BOM when editing the first line", async () => {
      // Construct content with explicit BOM at byte 0
      const bom = "\uFEFF";
      const originalContent = `${bom}# line 1\nline 2\nline 3\n`;
      await withTempFile("bom.txt", originalContent, async ({ cwd, path }) => {
        // Sanity check: file was written with BOM
        const buf = await readFile(path);
        expect(buf[0]).toBe(0xef);
        expect(buf[1]).toBe(0xbb);
        expect(buf[2]).toBe(0xbf);

        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["# line 1", "line 2", "line 3"];
        const ref = fullHashRef(lines, 1);

        const result = await editTool.execute(
          "e",
          {
            path: "bom.txt",
            edits: [
              {
                op: "replace",
                range: [ref, ref],
                lines: ["# REPLACED line 1"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(result.details?.metrics?.classification).not.toBe("noop");

        // The crucial assertion: the file must STILL start with the BOM
        const after = await readFile(path);
        expect(after[0]).toBe(0xef);
        expect(after[1]).toBe(0xbb);
        expect(after[2]).toBe(0xbf);
        expect(after.subarray(3).toString("utf-8")).toBe(
          "# REPLACED line 1\nline 2\nline 3\n",
        );
      });
    });
  });

  describe("Em-dash preservation (FIRST §1.1, SECOND §3.1)", () => {
    it("preserves U+2014 (em dash) in replacement content", async () => {
      const emDash = "\u2014";
      const content = `# line 1\nline 2\n# line 3 with ${emDash} em-dash\n`;
      await withTempFile("emdash.txt", content, async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const lines = ["# line 1", "line 2", `# line 3 with ${emDash} em-dash`];
        const ref = fullHashRef(lines, 3);

        const newLine = `Replaced with ${emDash} em-dash`;
        const result = await editTool.execute(
          "e",
          {
            path: "emdash.txt",
            edits: [{ op: "replace", range: [ref, ref], lines: [newLine] }],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(result.details?.metrics?.classification).not.toBe("noop");
        const after = await readFile(path, "utf-8");
        expect(after).toContain(emDash);
        expect(after).not.toMatch(/Replaced with - em-dash/);
        // Verify the actual byte sequence is the 3-byte UTF-8 em-dash
        const buf = await readFile(path);
        const text = buf.toString("utf-8");
        expect(text).toContain("\u2014");
      });
    });
  });
});
