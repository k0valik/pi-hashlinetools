import { describe, expect, it } from "vitest";
import {
  buildCompactHashlineDiffPreview,
  generateDiffString,
} from "../../src/edit-diff";

describe("generateDiffString", () => {
  it("adds line-number gutters for context, addition, and deletion lines", () => {
    const diff = generateDiffString(
      "alpha\nbeta\ngamma",
      "alpha\nBETA\ngamma",
    ).diff;

    expect(diff).toMatch(/ 1[A-Za-z0-9_-]{3}│alpha/);
    expect(diff).toMatch(/\+2[A-Za-z0-9_-]{3}│BETA/);
    expect(diff).toMatch(/-2[A-Za-z0-9_-]{3}│beta/);
    expect(diff).toMatch(/ 3[A-Za-z0-9_-]{3}│gamma/);
  });
});

describe("buildCompactHashlineDiffPreview", () => {
  it("collapses long unchanged runs and counts add/remove lines", () => {
    const diff = [
      " 1 ctx-a",
      " 2 ctx-b",
      " 3 ctx-c",
      " 4 ctx-d",
      "+5 added",
      "-6 removed",
      " 7 tail-a",
      " 8 tail-b",
      " 9 tail-c",
    ].join("\n");

    const preview = buildCompactHashlineDiffPreview(diff);

    expect(preview.preview).toContain("... 2 more unchanged lines");
    expect(preview.addedLines).toBe(1);
    expect(preview.removedLines).toBe(1);
  });
});
