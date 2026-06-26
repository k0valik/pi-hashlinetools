import { describe, expect, it } from "vitest";
import register from "../../index";
import {
  expectRefusedWithError,
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

/**
 * Regression test for the FIRST stress test report §2.2 and §6.2.
 *
 * Symptom: a single-line range replace that fails with a primary error
 * (e.g. E_LINE_CHANGED) would also emit a secondary
 * [E_BAD_REF] Invalid line reference "" and a [E_EDIT_REFUSED] warning
 * alongside the primary error. The user saw noisy output like:
 *
 *   [E_LINE_CHANGED] range start 5#Xy0 content does not match...
 *   [E_BAD_REF] Invalid line reference "". Expected "LINE#HASH"...
 *   [E_EDIT_REFUSED] The edit batch was refused: ...
 *
 * The agent's hypothesis (§6.2) was a /g regex with lastIndex state. The
 * real cause was that `tryDryRun`'s catch block synthesized edits with
 * `pos: ""` and passed them through `resolveEditAnchors` → `parseAnchorRef("")`
 * → E_BAD_REF with empty string. The apply try-catch then captured that
 * secondary error and emitted it as a warning.
 *
 * Fix: when anchor resolution throws, return a synthetic "all edits failed"
 * `DryRunResult` immediately. Do NOT pass the empty-pos edits through
 * `resolveEditAnchors`.
 */
describe("regression: no spurious E_BAD_REF empty string noise", () => {
  it('single-line replace that fails with E_LINE_CHANGED does NOT emit [E_BAD_REF] Invalid line reference ""', async () => {
    await withTempFile(
      "bad-ref-noise.txt",
      "a\nb\nc\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        // The line content on disk is "WRONG" but the user is providing a
        // ref whose content hint says "CORRECT" — this triggers
        // E_LINE_CHANGED (Layer 1: content doesn't match at the
        // expected position).
        const lines = ["WRONG"];
        const ref = fullHashRef(lines, 1);

        const result = await editTool.execute(
          "e",
          {
            path: "bad-ref-noise.txt",
            edits: [{ op: "replace", range: [ref, ref], lines: ["REPLACED"] }],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expectRefusedWithError(result, /\[E_LINE_CHANGED\]/);
        // The crucial assertion: no spurious E_BAD_REF with empty string.
        const text = result.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/Invalid line reference ""/);
      },
    );
  });
});
