import { describe, expect, it } from "vitest";
import {
  applyHashlineEdits,
  computeLineHash,
  type HashlineEdit,
} from "../../src/hashline";
import { computePublicLineChecksum } from "../../src/line-ref";

const sampleContent = "alpha\nbeta\ngamma\ndelta";

function makeTag(content: string, line: number) {
  const fileLines = content.split("\n");
  return { line, hash: computeLineHash(fileLines, line - 1) };
}

describe("applyHashlineEdits — bare hash prefix warning", () => {
  it("does not warn when edit content has no bare-prefix shapes", () => {
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: ["new content"],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("does not warn on a single bare 3-char prefix that does not match any file checksum", () => {
    const lines = sampleContent.split("\n");
    const realChecksums = new Set(
      lines.map((_, i) => computePublicLineChecksum(lines, i + 1)),
    );
    // Find a 3-char base64 string NOT in the file
    let nonMatchHash = "___";
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
      const candidate = c + "00";
      if (!realChecksums.has(candidate)) {
        nonMatchHash = candidate;
        break;
      }
    }
    expect(nonMatchHash.length).toBe(3);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${nonMatchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("warns and strips on a single bare 3-char prefix that matches a real file checksum", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1); // 3-char checksum of "alpha"
    expect(matchHash).toHaveLength(3);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toMatch(/W_BARE_HASH_PREFIX_STRIPPED/);
    // The prefix is stripped — file content is clean
    expect(result.content.split("\n")[1]).toBe("new content");
  });

  it("does NOT strip when ≥ 2 lines look like bare prefixes but 0 hashes match (false-positive guard for tables)", () => {
    // Stripping bare hashline prefixes when matchCount === 0 risks
    // corrupting legitimate
    // content that happens to use `│` as a separator (e.g. markdown
    // tables: col│value1, col│value2). At least ONE hash must match
    // a real public checksum in the file before we strip. The
    // `≥ 2 suspects` fallback was over-engineering for the rare
    // case of model pasting a different file's read output — false
    // negatives there are recoverable (re-read), false positives
    // here are silent data loss.

    const lines = sampleContent.split("\n");
    const realChecksums = new Set(
      lines.map((_, i) => computePublicLineChecksum(lines, i + 1)),
    );
    // Find two 3-char base64 strings not in the file
    const nonMatches: string[] = [];
    for (let a = 0; a < 26 && nonMatches.length < 2; a++) {
      const base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[a]!;
      for (let b = 0; b < 10 && nonMatches.length < 2; b++) {
        const candidate = base + b + "z";
        if (!realChecksums.has(candidate)) nonMatches.push(candidate);
      }
    }
    expect(nonMatches.length).toBe(2);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${nonMatches[0]}│first`, `${nonMatches[1]}│second`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    // No strip happens — both lines pass through unchanged
    expect(result.content.split("\n")[1]).toBe(`${nonMatches[0]}│first`);
    expect(result.content.split("\n")[2]).toBe(`${nonMatches[1]}│second`);
    // No warning either (confidence gate failed)
    expect(result.warnings ?? []).toEqual([]);
  });

  it("emits exactly one warning even with multiple bare prefixes (one match)", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1);
    const realChecksums = new Set(
      lines.map((_, i) => computePublicLineChecksum(lines, i + 1)),
    );
    let nonMatchHash = "___";
    for (let a = 0; a < 26; a++) {
      const base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[a]!;
      for (let b = 0; b < 10; b++) {
        const candidate = base + b + "w";
        if (!realChecksums.has(candidate)) {
          nonMatchHash = candidate;
          break;
        }
      }
      if (nonMatchHash !== "___") break;
    }

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${matchHash}│matched`, `${nonMatchHash}│unmatched`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    const bareWarnings =
      result.warnings?.filter((w) => /W_BARE_HASH_PREFIX_STRIPPED/.test(w)) ??
      [];
    expect(bareWarnings.length).toBe(1);
    // Both prefixes stripped
    expect(result.content.split("\n")[1]).toBe("matched");
    expect(result.content.split("\n")[2]).toBe("unmatched");
  });

  it("accepts bare prefix with │ separator only (3-char base64 format)", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1);
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${matchHash}│matched`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toMatch(/W_BARE_HASH_PREFIX_STRIPPED/);
    expect(result.content.split("\n")[1]).toBe("matched");
  });

  it("strips the prefix and applies the clean content (no more corrupted file)", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1);
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);
    // Edit applied with CLEAN content (prefix stripped)
    expect(result.content.split("\n")[1]).toBe("new content");
    // Plus a brief reminder warning
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("applyHashlineEdits — bare hash prefix STRIP (the fix)", () => {
  it("strips a single bare prefix that matches a real file checksum", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1); // real checksum of "alpha"
    expect(matchHash).toHaveLength(3);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    // The hashline prefix must be stripped — file content must NOT contain the prefix
    expect(result.content.split("\n")[1]).toBe("new content");

    // A brief reminder warning is fired
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
    const reminder = result.warnings?.find(
      (w) => /bare.hash.prefix/i.test(w) || /hash.prefix.stripped/i.test(w),
    );
    expect(reminder).toBeDefined();
  });

  it("does NOT strip multiple bare prefixes when 0 hashes match (false-positive guard)", () => {
    const lines = sampleContent.split("\n");
    const realChecksums = new Set(
      lines.map((_, i) => computePublicLineChecksum(lines, i + 1)),
    );
    // Find two 3-char base64 strings NOT in the file
    const nonMatches: string[] = [];
    for (let a = 0; a < 26 && nonMatches.length < 2; a++) {
      const base = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[a]!;
      for (let b = 0; b < 10 && nonMatches.length < 2; b++) {
        const candidate = base + b + "z";
        if (!realChecksums.has(candidate)) nonMatches.push(candidate);
      }
    }
    expect(nonMatches.length).toBe(2);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${nonMatches[0]}│first line`, `${nonMatches[1]}│second line`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    // No strip happens — both lines pass through unchanged.
    // This is the false-positive guard: a markdown table with
    // `xxx│value1, yyy│value2` should NOT be silently mutated.
    expect(result.content.split("\n")[1]).toBe(`${nonMatches[0]}│first line`);
    expect(result.content.split("\n")[2]).toBe(`${nonMatches[1]}│second line`);

    // No warning either (confidence gate failed: matchCount === 0)
    expect(result.warnings ?? []).toEqual([]);
  });

  it("does NOT strip a single bare prefix that does not match any file checksum (ambiguous — could be content)", () => {
    const lines = sampleContent.split("\n");
    const realChecksums = new Set(
      lines.map((_, i) => computePublicLineChecksum(lines, i + 1)),
    );
    // Find a 3-char base64 string NOT in the file
    let nonMatchHash = "___";
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
      const candidate = c + "00";
      if (!realChecksums.has(candidate)) {
        nonMatchHash = candidate;
        break;
      }
    }
    expect(nonMatchHash.length).toBe(3);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`${nonMatchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    // No strip happens — the line passes through unchanged
    expect(result.content.split("\n")[1]).toBe(`${nonMatchHash}│new content`);
    // No warning either
    expect(result.warnings ?? []).toEqual([]);
  });

  it("strips read-tool format (line# + hash + separator) when hash matches", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1); // checksum of "alpha"
    expect(matchHash).toHaveLength(3);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        // Format: <lineNumber><hash>│<content> (no # separator, public read format)
        lines: [`1${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    // The line number + hash + separator is all stripped — only the content remains
    expect(result.content.split("\n")[1]).toBe("new content");
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toMatch(/W_BARE_HASH_PREFIX_STRIPPED/);
  });

  it("strips diff addition format (+line#hash│content)", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`+1${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    expect(result.content.split("\n")[1]).toBe("new content");
    expect(result.warnings?.[0]).toMatch(/W_BARE_HASH_PREFIX_STRIPPED/);
  });

  it("strips diff deletion format (-line#hash│content)", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [`-1${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    expect(result.content.split("\n")[1]).toBe("new content");
    expect(result.warnings?.[0]).toMatch(/W_BARE_HASH_PREFIX_STRIPPED/);
  });

  it("strips diff context format (line#hash│content with leading space)", () => {
    const lines = sampleContent.split("\n");
    const matchHash = computePublicLineChecksum(lines, 1);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        lines: [` 1${matchHash}│new content`],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    expect(result.content.split("\n")[1]).toBe("new content");
    expect(result.warnings?.[0]).toMatch(/W_BARE_HASH_PREFIX_STRIPPED/);
  });

  it("strips multiple lines with different read-output formats in one edit", () => {
    const lines = sampleContent.split("\n");
    const hashAlpha = computePublicLineChecksum(lines, 1);
    const hashBeta = computePublicLineChecksum(lines, 2);

    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(sampleContent, 2),
        // Mix: bare hash, line#hash, +line#hash
        lines: [
          `${hashAlpha}│bare`,
          `1${hashAlpha}│with-lineno`,
          `+2${hashBeta}│with-diff-prefix`,
        ],
      },
    ];
    const result = applyHashlineEdits(sampleContent, edits);

    // All three lines stripped
    expect(result.content.split("\n")[1]).toBe("bare");
    expect(result.content.split("\n")[2]).toBe("with-lineno");
    expect(result.content.split("\n")[3]).toBe("with-diff-prefix");
  });
});
