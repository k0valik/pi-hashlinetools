import { describe, expect, it } from "vitest";
import {
  computeLineHash,
  hashlineParseText,
  resolveEditAnchors,
} from "../../src/hashline";

describe("resolveEditAnchors", () => {
  it("resolves replace with pos + end", () => {
    const hash1 = computeLineHash(["line a"], 0);
    const hash2 = computeLineHash(["line b"], 0);
    const edits = resolveEditAnchors([
      {
        op: "replace",
        pos: `1#${hash1}`,
        end: `2#${hash2}`,
        lines: ["new"],
      },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.op).toBe("replace");
    expect(edits[0]!.pos).toEqual({ line: 1, hash: hash1 });
    expect(edits[0]!.end).toEqual({ line: 2, hash: hash2 });
    expect(edits[0]!.lines).toEqual(["new"]);
  });

  it("resolves replace with pos only (single-line)", () => {
    const hash = computeLineHash(["target"], 0);
    const edits = resolveEditAnchors([
      { op: "replace", pos: `5#${hash}`, lines: ["updated"] },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.pos).toEqual({ line: 5, hash });
    expect(edits[0]!.end).toBeUndefined();
    expect(edits[0]!.lines).toEqual(["updated"]);
  });

  it("throws on malformed pos for replace", () => {
    expect(() =>
      resolveEditAnchors([{ op: "replace", pos: "garbage", lines: ["x"] }]),
    ).toThrow(/Invalid line reference/);
  });

  it("throws on malformed end for replace with valid pos", () => {
    const hash = computeLineHash(["a"], 0);
    expect(() =>
      resolveEditAnchors([
        { op: "replace", pos: `1#${hash}`, end: "garbage", lines: ["x"] },
      ]),
    ).toThrow(/Invalid line reference/);
  });

  it("parses string lines input", () => {
    const hash = computeLineHash(["a"], 0);
    const edits = resolveEditAnchors([
      { op: "replace", pos: `1#${hash}`, lines: "hello\nworld" },
    ]);
    expect(edits[0]!.lines).toEqual(["hello", "world"]);
  });

  it("parses null lines as empty array", () => {
    const hash = computeLineHash(["a"], 0);
    const edits = resolveEditAnchors([
      { op: "replace", pos: `1#${hash}`, lines: null as any },
    ]);
    expect(edits[0]!.lines).toEqual([]);
  });

  it("strips display prefixes in lines through hashlineParseText", () => {
    const content = "content";
    const hash = computeLineHash([content], 0);
    const edits = resolveEditAnchors([
      { op: "replace", pos: `1#${hash}`, lines: [`1#${hash}│${content}`] },
    ]);
    expect(edits[0]!.lines).toEqual([content]);
  });
});
