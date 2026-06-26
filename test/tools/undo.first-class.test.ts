import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry } from "../support/fixtures";

const PKG_ROOT = join(__dirname, "..", "..");

/**
 *  undo becomes a first-class tool — visible in the system
 * prompt's `Available tools:` list. Visibility requires a `promptSnippet`.
 *
 * Visibility matters: the system prompt's `Available tools:` list filters
 * by `promptSnippet`, so a tool without one isn't announced. The `undo`
 * tool has a runtime use case ("many edits then a final wrong one") that
 * models have to learn exists, so the snippet is the announcement.
 */
describe("undo tool is first-class ( )", () => {
  it("the registered tool carries a promptSnippet field", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const undoTool = getTool("undo");
    expect(undoTool.promptSnippet).toBeDefined();
    expect(typeof undoTool.promptSnippet).toBe("string");
    expect((undoTool.promptSnippet as string).length).toBeGreaterThan(0);
  });

  it("the promptSnippet matches the contents of tool-descriptions/undo-snippet.md", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const undoTool = getTool("undo");
    const onDisk = readFileSync(
      join(PKG_ROOT, "tool-descriptions", "undo-snippet.md"),
      "utf-8",
    ).trim();
    expect(undoTool.promptSnippet).toBe(onDisk);
  });

  it("the description is the one-liner from tool-descriptions/undo.md", () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const undoTool = getTool("undo");
    const onDisk = readFileSync(
      join(PKG_ROOT, "tool-descriptions", "undo.md"),
      "utf-8",
    ).trim();
    expect(undoTool.description).toBe(onDisk);
    // And the description is short — happy-path one-liner, no "Limitations"
    expect(onDisk.split("\n").length).toBe(1);
  });
});
