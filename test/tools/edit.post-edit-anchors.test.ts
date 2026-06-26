import { afterEach, describe, expect, it } from "vitest";
import register from "../../index";
import {
  isAutoReadEnabled,
  setAutoReadEnabled,
} from "../../src/auto-read-state";
import {
  fullHashRef,
  makeFakePiRegistry,
  withTempFile,
} from "../support/fixtures";

/**
 * P2.1: gate the inline post-edit anchor block behind the same gate
 * as the auto-read after-write/edit handler. The anchor block adds
 * 4 context lines above and below the changed region (up to 9 lines)
 * plus a summary line. On every multi-edit, the model pays the token
 * cost even when it has no intent to chain. The fix: only emit the
 * anchor block when the gate is ON.
 *
 * Default state: OFF (matches the auto-read handler default).
 * Set via the PI_HASHLINE_AUTO_READ env var, the /toggle-auto-read
 * command, or the `setAutoReadEnabled` setter exported from
 * `auto-read-state.ts` (for tests).
 */
describe("edit tool post-edit anchor block (P2.1)", () => {
  // Save and restore the gate state around every test.
  let prev: boolean;
  afterEach(() => {
    setAutoReadEnabled(prev);
  });

  function snapshotGate(): void {
    prev = isAutoReadEnabled();
  }

  it("does NOT emit 'Post-edit anchors' for a multi-edit when the gate is OFF (default)", async () => {
    snapshotGate();
    await withTempFile(
      "anchors.txt",
      "line 1\nline 2\nline 3\nline 4\nline 5\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        // register() may flip the gate based on env var. For this test
        // we want it OFF regardless of env.
        setAutoReadEnabled(false);
        const editTool = getTool("edit");
        const fileLines = ["line 1", "line 2", "line 3", "line 4", "line 5"];
        const r1 = fullHashRef(fileLines, 1);
        const r3 = fullHashRef(fileLines, 3);

        const result = await editTool.execute(
          "e1",
          {
            path: "anchors.txt",
            edits: [
              { op: "replace", range: [r1, r1], lines: ["LINE 1 NEW"] },
              { op: "replace", range: [r3, r3], lines: ["LINE 3 NEW"] },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        const text = result.content?.[0]?.text ?? "";
        // The anchor block should be absent.
        expect(text).not.toMatch(/Post-edit anchors/);
        // The edit itself still applied.
        expect(
          await import("node:fs/promises").then((m) =>
            m.readFile(path, "utf-8"),
          ),
        ).toBe("LINE 1 NEW\nline 2\nLINE 3 NEW\nline 4\nline 5\n");
      },
    );
  });

  it("DOES emit 'Post-edit anchors' for a multi-edit when the gate is ON", async () => {
    snapshotGate();
    await withTempFile(
      "anchors.txt",
      "line 1\nline 2\nline 3\nline 4\nline 5\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        // register() may have flipped the gate based on env var.
        // Force it ON for this test.
        setAutoReadEnabled(true);
        const editTool = getTool("edit");
        const fileLines = ["line 1", "line 2", "line 3", "line 4", "line 5"];
        const r1 = fullHashRef(fileLines, 1);
        const r3 = fullHashRef(fileLines, 3);

        const result = await editTool.execute(
          "e1",
          {
            path: "anchors.txt",
            edits: [
              { op: "replace", range: [r1, r1], lines: ["LINE 1 NEW"] },
              { op: "replace", range: [r3, r3], lines: ["LINE 3 NEW"] },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        const text = result.content?.[0]?.text ?? "";
        // The anchor block should be present.
        expect(text).toMatch(/Post-edit anchors/);
        // The anchor block should include the unchanged context line
        // (line 2 between the two edits) with a hashline ref. The
        // public ref format is "<line><3-char-base64>" (e.g. "2mWm").
        expect(text).toMatch(/2\w{3}│line 2/);
      },
    );
  });

  it("does NOT emit the anchor block for a single-edit regardless of the gate", async () => {
    // The current behavior: anchor block only fires for multi-edit
    // (`hashlineEdits.length > 1`). A single edit is small enough
    // that the diff + warnings are sufficient. The gate should not
    // change this — the gate only gates multi-edit anchors.
    snapshotGate();
    await withTempFile(
      "anchors.txt",
      "line 1\nline 2\nline 3\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        setAutoReadEnabled(true);
        const editTool = getTool("edit");
        const fileLines = ["line 1", "line 2", "line 3"];
        const r2 = fullHashRef(fileLines, 2);

        const result = await editTool.execute(
          "e1",
          {
            path: "anchors.txt",
            edits: [{ op: "replace", range: [r2, r2], lines: ["LINE 2 NEW"] }],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        const text = result.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/Post-edit anchors/);
      },
    );
  });
});
