import { readFile, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import register from "../../index";
import { clearLastEdit, setCurrentTurn } from "../../src/undo";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("undo.robust.test.ts - Undo Robustness", () => {
  beforeEach(() => {
    clearLastEdit();
    setCurrentTurn(0);
  });

  it("respects the turn window (MAX_UNDO_TURNS = 3)", async () => {
    await withTempFile(
      "undo_turns.txt",
      "original\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");
        const undoTool = getTool("undo");
        const readTool = getTool("read");

        // Turn 1: Initial Edit
        setCurrentTurn(1);
        await editTool.execute(
          "e1",
          {
            path: "undo_turns.txt",
            edits: [
              { range: ["1aa│original", "1aa│original"], lines: ["edited"] },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );
        expect(await readFile(path, "utf-8")).toBe("edited\n");

        // Turn 2: Some other tool call
        setCurrentTurn(2);
        await readTool.execute(
          "r1",
          { path: "undo_turns.txt" },
          undefined,
          undefined,
          { cwd } as any,
        );

        // Turn 3: Another tool call
        setCurrentTurn(3);
        await readTool.execute(
          "r2",
          { path: "undo_turns.txt" },
          undefined,
          undefined,
          { cwd } as any,
        );

        // Turn 4: Still within window (4 - 1 = 3 <= 3)
        setCurrentTurn(4);
        await undoTool.execute("u1", {}, undefined, undefined, { cwd } as any);
        expect(await readFile(path, "utf-8")).toBe("original\n");

        // Re-edit for next part
        setCurrentTurn(5);
        await editTool.execute(
          "e2",
          {
            path: "undo_turns.txt",
            edits: [
              {
                range: ["1aa│original", "1aa│original"],
                lines: ["edited again"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd } as any,
        );

        // Turn 6, 7, 8
        setCurrentTurn(6);
        setCurrentTurn(7);
        setCurrentTurn(8);

        // Turn 9: Outside window (9 - 5 = 4 > 3)
        setCurrentTurn(9);
        await expect(
          undoTool.execute("u2", {}, undefined, undefined, { cwd } as any),
        ).rejects.toThrow(/E_NO_UNDO|window expired/);
      },
    );
  });

  it("handles undo after external file modifications (rollback/verify)", async () => {
    await withTempFile("undo_external.txt", "a\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const undoTool = getTool("undo");

      setCurrentTurn(1);
      await editTool.execute(
        "e1",
        {
          path: "undo_external.txt",
          edits: [{ range: ["1aa│a", "1aa│a"], lines: ["A"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      // External modification
      await writeFile(path, "EXTERNAL\n");

      // Undo should still try to restore "a\n"
      await undoTool.execute("u1", {}, undefined, undefined, { cwd } as any);
      expect(await readFile(path, "utf-8")).toBe("a\n");
    });
  });

  it("fails undo if no edit was made", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const undoTool = getTool("undo");

    await expect(
      undoTool.execute("u1", {}, undefined, undefined, { cwd: "/tmp" } as any),
    ).rejects.toThrow(/E_NO_UNDO/);
  });
});
