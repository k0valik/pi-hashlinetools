import { describe, expect, it } from "vitest";
import {
  computeLineHash,
  type HashlineToolEdit,
  resolveEditAnchors,
} from "../../src/hashline";

describe("strict edit input (no autocorrection)", () => {
  it("strips array lines containing rendered LINE#HASH: prefixes", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const fooHash = computeLineHash(["foo"], 0);
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: [`1#${fooHash}│foo`] },
    ];
    // No longer throws — prefixes with line numbers are auto-stripped
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["foo"]);
    }
  });

  it("preserves bare HASH│ prefix without line number (ambiguous — handled by warning)", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["A4│foo"] },
    ];
    // Bare hash prefix (no line number) — NOT stripped, could be content
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["A4│foo"]);
    }
  });

  it("preserves +HASH│ prefix without line number (ambiguous)", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: "+A4│foo" },
    ];
    // No line number → ambiguous → preserved
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["+A4│foo"]);
    }
  });

  it("strips string lines containing rendered diff additions (+LINE# prefix)", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const fooHash = computeLineHash(["foo"], 0);
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: `+1#${fooHash}│foo` },
    ];
    // Has line number → stripped
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["foo"]);
    }
  });

  it("drops diff deletion rows (- lines are deletions in copy-pasted diffs)", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["-1    foo"] },
    ];
    // Diff minus lines are dropped entirely — they represent deletions
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual([]);
    }
  });

  it("accepts plain literal content unchanged", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["bar"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["bar"]);
    } else {
      throw new Error("expected replace");
    }
  });

  it("preserves '#' comment lines that do not match the strict prefix", () => {
    const tag = `1#${computeLineHash(["foo"], 0)}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["# Note: keep me"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["# Note: keep me"]);
    } else {
      throw new Error("expected replace");
    }
  });
});
