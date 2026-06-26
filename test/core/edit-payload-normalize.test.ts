import { describe, expect, it } from "vitest";
import {
  broadRangeToInsert,
  normalizeEditPayload,
  restoreIndent,
  stripAnchorEcho,
  validateAndFixLines,
} from "../../src/edit-payload-normalize";
import type { HashlineToolEdit } from "../../src/hashline";
import {
  computePublicLineChecksum,
  formatPublicLineRef,
} from "../../src/line-ref";

describe("validateAndFixLines", () => {
  it("returns empty array for null", () => {
    const r = validateAndFixLines(null, 0);
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.emptyAfterStrip).toBe(false);
  });

  it("returns empty array for undefined", () => {
    const r = validateAndFixLines(undefined, 0);
    expect(r.lines).toEqual([]);
    expect(r.emptyAfterStrip).toBe(false);
  });

  it("normalizes a string to lines", () => {
    const r = validateAndFixLines("foo\nbar\n", 0);
    expect(r.lines).toEqual(["foo", "bar"]);
    expect(r.warnings).toEqual([]);
  });

  it("strips a LINE#ID│ display prefix (case 1) — silent on success ", () => {
    const r = validateAndFixLines(["42#Xy0│const x = 1"], 0);
    expect(r.lines).toEqual(["const x = 1"]);
    //  silent on success. The diff shows what applied.
    expect(r.warnings).toEqual([]);
    expect(r.emptyAfterStrip).toBe(false);
  });

  it("strips a `>>> 42#Xy0│` prefix (case 3) — silent on success ", () => {
    const r = validateAndFixLines([">>> 42#Xy0│const x = 1"], 0);
    expect(r.lines).toEqual(["const x = 1"]);
    //  silent on success.
    expect(r.warnings).toEqual([]);
  });

  it("drops a `- 2    content` diff-marker line (case 2) — silent on success ", () => {
    const r = validateAndFixLines(["- 2    const x = 1", "real content"], 0);
    expect(r.lines).toEqual(["real content"]);
    //  silent on success — the diff-marker was invalid, the result is correct.
    expect(r.warnings).toEqual([]);
    expect(r.emptyAfterStrip).toBe(false);
  });

  it("preserves a single prefix-only line as a blank line", () => {
    // A line like "42#Xy0│" with no content after the prefix:
    // a blank line in a multi-line replace is a real "empty line in
    // the file" the user may have wanted. The line is preserved
    // as "" and the edit is treated as a valid "replace with blank".
    // emptyAfterStrip is therefore false — there IS a valid (empty)
    const r = validateAndFixLines(["42#Xy0│"], 0);
    expect(r.emptyAfterStrip).toBe(false);
    expect(r.lines).toEqual([""]);
    //  silent on success.
    expect(r.warnings).toEqual([]);
  });

  it("flags empty-after-strip when a diff marker is the ONLY line — case 7 ", () => {
    // The original "case 7" test. A diff marker line like
    // "- 2    only line" is dropped entirely (it's not user content),
    // so the result has no valid line. emptyAfterStrip is true.
    const r = validateAndFixLines(["- 2    only line"], 0);
    expect(r.emptyAfterStrip).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/W_DIFF_MARKER_IN_LINES/);
  });

  it("does NOT flag empty-after-strip when one line is prefix-only but others have content — silent on success", () => {
    // The bug: the early return on a single prefix-only line stopped
    // processing the rest of the lines, so a multi-line edit like
    // ["42#Xy0│", "real content"] would incorrectly fail with
    // E_INVALID_PATCH even though the second line is perfectly valid.
    //
    // The blank-after-strip line is
    // preserved as "" instead of silently dropped — a blank line in
    // the middle of a multi-line replace is real user content.
    const r = validateAndFixLines(["42#Xy0│", "real content"], 0);
    expect(r.emptyAfterStrip).toBe(false);
    expect(r.lines).toEqual(["", "real content"]);
    //  silent on success. No warning for the stripped prefix.
    expect(r.warnings).toEqual([]);
  });

  it("flags empty-after-strip when diff-marker drop empties the array", () => {
    const r = validateAndFixLines(["- 2    only line"], 0);
    expect(r.emptyAfterStrip).toBe(true);
  });

  it("does not flag empty for a legitimately empty lines array", () => {
    // Caller's responsibility: empty array is "delete", not "empty after strip".
    const r = validateAndFixLines([], 0);
    expect(r.lines).toEqual([]);
    expect(r.emptyAfterStrip).toBe(false);
  });

  it("is silent when multiple display prefixes are stripped ", () => {
    // Pre- 2 lines stripped → 2 per-line warnings.
    // Post- silent on success. The diff shows what applied.
    const r = validateAndFixLines(["42#Xy0│a", "real b", "12#Ab1│c"], 0);
    expect(r.lines).toEqual(["a", "real b", "c"]);
    expect(r.warnings).toEqual([]);
  });
});

describe("stripAnchorEcho", () => {
  it("strips leading echo for range replace (multi-line range) and emits a reminder (P3 modified)", () => {
    const r = stripAnchorEcho(
      ["const x = 1;", "const y = 2;"],
      "const x = 1;",
      "const z = 3;", // end content → multi-line range
      "replace",
      0,
    );
    expect(r.lines).toEqual(["const y = 2;"]);
    // P3 (modified): auto-fix happens silently in the
    // background, but the model gets a brief reminder per stripped
    // line. NOT a hard error.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /\[W_ANCHOR_ECHO_STRIPPED\].*edit 0.*leading/,
    );
  });

  it("strips leading echo for append op and emits a reminder (P3 modified)", () => {
    const r = stripAnchorEcho(
      ["const x = 1;", "const y = 2;"],
      "const x = 1;",
      undefined,
      "append",
      0,
    );
    expect(r.lines).toEqual(["const y = 2;"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /\[W_ANCHOR_ECHO_STRIPPED\].*edit 0.*leading/,
    );
  });

  it("strips leading echo for prepend op and emits a reminder (P3 modified)", () => {
    // For prepend, the model thinks "the anchor needs to stay, plus
    // new content before it", so the natural mistake is to put the
    // anchor at lines[0].
    const r = stripAnchorEcho(
      ["const x = 1;", "const y = 2;"],
      "const x = 1;",
      undefined,
      "prepend",
      0,
    );
    expect(r.lines).toEqual(["const y = 2;"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /\[W_ANCHOR_ECHO_STRIPPED\].*edit 0.*leading/,
    );
  });

  it("strips trailing echo for range replace and emits a reminder (P3 modified)", () => {
    const r = stripAnchorEcho(
      ["new content", "}"],
      "start line",
      "}",
      "replace",
      0,
    );
    expect(r.lines).toEqual(["new content"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /\[W_ANCHOR_ECHO_STRIPPED\].*edit 0.*trailing/,
    );
  });

  it("strips both leading and trailing echo and emits two reminders (P3 modified)", () => {
    const r = stripAnchorEcho(
      ["start line", "new content", "}"],
      "start line",
      "}",
      "replace",
      0,
    );
    expect(r.lines).toEqual(["new content"]);
    // Two strips, two reminders (one for leading, one for trailing).
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/leading/);
    expect(r.warnings[1]).toMatch(/trailing/);
  });

  it("does not strip when leading line is different from anchor", () => {
    const r = stripAnchorEcho(
      ["foo", "bar"],
      "const x = 1;",
      undefined,
      "replace",
      0,
    );
    expect(r.lines).toEqual(["foo", "bar"]);
    expect(r.warnings).toEqual([]);
  });

  it("tolerates whitespace differences (wsEq) and emits a reminder (P3 modified)", () => {
    const r = stripAnchorEcho(
      ["const x = 1;   ", "new"],
      "const x = 1;",
      undefined,
      "append",
      0,
    );
    expect(r.lines).toEqual(["new"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/\[W_ANCHOR_ECHO_STRIPPED\]/);
  });

  it('does NOT strip single-line replace with `lines: ["anchor"]` (noop)', () => {
    // Conservative rule: a single-line replace whose only
    // replacement line equals the anchor is a noop, not a duplicate.
    // Matches pi-readseek's `length > 1` guard.
    const r = stripAnchorEcho(
      ["const x = 1;"],
      "const x = 1;",
      undefined,
      "replace",
      0,
    );
    expect(r.lines).toEqual(["const x = 1;"]);
    expect(r.warnings).toEqual([]);
  });

  it("does NOT strip leading echo for single-line replace even with multiple lines", () => {
    // For single-line replace, the range is just the one anchor
    // line. There's no duplicate to fix — `lines: [anchor, new]`
    // is the model intentionally keeping the anchor and adding new
    // content after it. Preserve the old behavior.
    const r = stripAnchorEcho(
      ["const x = 1;", "const y = 2;"],
      "const x = 1;",
      undefined, // no end content → single-line replace
      "replace",
      0,
    );
    expect(r.lines).toEqual(["const x = 1;", "const y = 2;"]);
    expect(r.warnings).toEqual([]);
  });

  it("does not strip trailing echo for single-line replace (no `end` content)", () => {
    const r = stripAnchorEcho(
      ["new content", "}"],
      "start line",
      undefined, // no end content → single-line replace
      "replace",
      0,
    );
    expect(r.lines).toEqual(["new content", "}"]);
    expect(r.warnings).toEqual([]);
  });

  it("does not strip when anchor line is undefined", () => {
    const r = stripAnchorEcho(["a", "b"], undefined, undefined, "replace", 0);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.warnings).toEqual([]);
  });

  it("returns empty array untouched", () => {
    const r = stripAnchorEcho([], "x", "y", "replace", 0);
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("restoreIndent", () => {
  it("restores indent when lines[i] has zero leading whitespace and anchor is indented", () => {
    const r = restoreIndent(["foo", "bar"], "    const x = 1", undefined, 0);
    expect(r.lines).toEqual(["    foo", "    bar"]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/W_INDENT_RESTORED/);
  });

  it("does not restore when lines[i] already has indent", () => {
    const r = restoreIndent(
      ["  foo", "    bar"],
      "    const x = 1",
      undefined,
      0,
    );
    expect(r.lines).toEqual(["  foo", "    bar"]);
    expect(r.warnings).toEqual([]);
  });

  it("does not restore when anchor has zero indent", () => {
    const r = restoreIndent(["foo"], "const x = 1", undefined, 0);
    expect(r.lines).toEqual(["foo"]);
    expect(r.warnings).toEqual([]);
  });

  it("does not touch empty lines", () => {
    const r = restoreIndent(["", "foo"], "    const x = 1", undefined, 0);
    expect(r.lines).toEqual(["", "    foo"]);
    expect(r.warnings).toHaveLength(1);
  });

  it("restores last line at range-end indent when range-end is less indented", () => {
    // Per the plan: restoreIndent only adds indent when lines[i] has
    // ZERO leading whitespace. So both lines start with no indent;
    // the first gets the anchor's indent (4 spaces), then the last
    // is overwritten with the range-end's indent (2 spaces).
    const r = restoreIndent(
      ["block content", "closing"],
      "    const x = 1",
      "  end of block",
      0,
    );
    expect(r.lines).toEqual(["    block content", "  closing"]);
    expect(r.warnings).toHaveLength(2);
  });

  it("returns empty array untouched", () => {
    const r = restoreIndent([], "    x", undefined, 0);
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("broadRangeToInsert", () => {
  function ref(fileLines: string[], n: number): string {
    return formatPublicLineRef(fileLines, n);
  }

  it("converts wide range + single line + no overlap → prepend on line after end", () => {
    const fileLines = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
    ];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 3),
      end: ref(fileLines, 9),
      lines: ["This is a brand new comment with no shared tokens."],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).not.toBeNull();
    expect(r.edit?.op).toBe("prepend");
    expect(r.edit?.end).toBeUndefined();
    expect(r.edit?.lines).toEqual([
      "This is a brand new comment with no shared tokens.",
    ]);
    // New pos should be the ref for line 10 (line after end=9)
    const expectedPos = ref(fileLines, 10);
    expect(r.edit?.pos).toBe(expectedPos);
    expect(r.warning).toMatch(/W_RANGE_TOO_BROAD/);
  });

  it("does NOT convert when single line shares substantial tokens with range (collapse)", () => {
    const fileLines = [
      "line 1",
      "line 2 with shared token",
      "line 3 with shared token",
      "line 4 with shared token",
      "line 5 with shared token",
    ];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 2),
      end: ref(fileLines, 4),
      // "line 2 with shared token" — 5 of 5 tokens appear in the range
      lines: ["line 2 with shared token"],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
    expect(r.warning).toBeNull();
  });

  it("does NOT convert when range is single-line (start === end)", () => {
    const fileLines = ["a", "b", "c"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 1),
      lines: ["new"],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
  });

  it("does NOT convert when range is inverted (start > end)", () => {
    // The bug: a model passing `range: [15, 5]` (inverted) used to
    // pass the `===` check and then auto-fix to a prepend on
    // end+1 = 6, masking the real E_BAD_RANGE error. The fix uses
    // `>=` so both single-line and inverted ranges are rejected
    // here and propagate to the proper downstream error.
    const fileLines = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
      "line 13",
      "line 14",
      "line 15",
    ];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 15), // > end
      end: ref(fileLines, 5),
      lines: ["a brand new comment with no shared tokens."],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
    expect(r.warning).toBeNull();
  });

  it("does NOT convert when lines has more than one entry", () => {
    const fileLines = ["a", "b", "c", "d", "e"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 4),
      lines: ["new 1", "new 2"],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
  });

  it("does NOT convert when end is the last line (no room to prepend)", () => {
    const fileLines = ["a", "b", "c"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 3),
      lines: ["unrelated insertion text"],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
  });

  it("does NOT convert when op is not replace", () => {
    const fileLines = ["a", "b", "c", "d", "e"];
    const edit: HashlineToolEdit = {
      op: "append",
      pos: ref(fileLines, 1),
      lines: ["new"],
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
  });

  it("does NOT convert when the single replacement line is empty (after tokenize)", () => {
    const fileLines = ["a", "b", "c", "d", "e"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 3),
      lines: ["!!!"], // punctuation only → empty tokens
    };
    const r = broadRangeToInsert(edit, fileLines, 0);
    expect(r.edit).toBeNull();
  });
});

describe("normalizeEditPayload", () => {
  function ref(fileLines: string[], n: number): string {
    return formatPublicLineRef(fileLines, n);
  }

  it("composes all 4 helpers — full case", () => {
    const fileLines = [
      "    const x = 1;", // 1
      "    const y = 2;", // 2 (anchor: indented)
      "    const z = 3;", // 3
      "    const w = 4;", // 4
      "    }", // 5 (range end)
      "after block", // 6
    ];
    // Model mistake: prefix + anchor echo + zero indent
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 2),
      end: ref(fileLines, 5),
      // Echo of anchor (line 2) at the start, and echo of range end (line 5) at the end.
      // Both should be stripped. Plus zero-indent body should be restored to 4 spaces.
      lines: [
        "    const y = 2;", // echo
        "new line 1", // zero-indent
        "new line 2", // zero-indent
        "    }", // trailing echo
      ],
    };
    const r = normalizeEditPayload([edit], fileLines);
    expect(r.warnings.length).toBeGreaterThan(0);
    // The echoes should be stripped, the zero-indent lines should have indent restored
    expect(r.edits[0]?.lines).toEqual(["    new line 1", "    new line 2"]);
  });

  it("strips display prefix in lines — silent on success ", () => {
    const fileLines = ["const x = 1;"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 1),
      lines: ["1#Xy0│new content"],
    };
    const r = normalizeEditPayload([edit], fileLines);
    expect(r.edits[0]?.lines).toEqual(["new content"]);
    //  silent on success. The diff shows what applied.
    expect(r.warnings).toEqual([]);
  });

  it("does NOT strip anchor echo for single-line replace (conservative noop)", () => {
    // `range: [a, a]` (single-line replace) with `lines: [a, new]`
    // is a legitimate pattern: the model intends to keep the anchor
    // and add content after it. We do NOT strip the leading echo
    // (that would break a common model pattern). Stripping only
    // happens for multi-line range replace where the first line
    // of `lines` duplicates the first line of the range.
    const fileLines = ["const x = 1;", "const y = 2;"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 1), // same as pos → single-line replace
      lines: ["const x = 1;", "real new content"],
    };
    const r = normalizeEditPayload([edit], fileLines);
    expect(r.edits[0]?.lines).toEqual(["const x = 1;", "real new content"]);
    expect(r.warnings.some((w) => w.includes("W_ANCHOR_ECHO"))).toBe(false);
  });

  it("converts wide range → prepend via broadRangeToInsert", () => {
    const fileLines = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 2),
      end: ref(fileLines, 6),
      lines: ["totally new comment line"],
    };
    const r = normalizeEditPayload([edit], fileLines);
    expect(r.edits[0]?.op).toBe("prepend");
    expect(r.warnings.some((w) => w.includes("W_RANGE_TOO_BROAD"))).toBe(true);
  });

  it("throws E_INVALID_PATCH when lines is empty after stripping (diff-marker only)", () => {
    // A single prefix-only line like "1#Xy0│" is no longer a stripping
    // error — it's treated as "replace with a blank line". The emptyAfterStrip
    // path is only triggered when stripping left us with NO valid
    // line at all. A diff-marker line like "- 2    only line" is
    // dropped entirely (not user content) and trips the error.
    const fileLines = ["x"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 1),
      lines: ["- 2    only line"],
    };
    expect(() => normalizeEditPayload([edit], fileLines)).toThrow(
      /E_INVALID_PATCH/,
    );
  });

  it("treats a single prefix-only line as a valid 'replace with blank'", () => {
    // The new contract: "1#Xy0│" with nothing after the prefix is
    // preserved as "" in the result. The edit is valid: it replaces
    // line 1 with a blank line. No E_INVALID_PATCH.
    const fileLines = ["x"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 1),
      lines: ["1#Xy0│"],
    };
    const r = normalizeEditPayload([edit], fileLines);
    expect(r.edits[0]?.lines).toEqual([""]);
  });

  it("does not touch replace_text edits", () => {
    const fileLines: string[] = [];
    const edit: HashlineToolEdit = {
      op: "replace_text",
      pos: "",
      oldText: "foo",
      newText: "bar",
    };
    const r = normalizeEditPayload([edit], fileLines);
    expect(r.edits[0]).toEqual(edit);
    expect(r.warnings).toEqual([]);
  });

  it("preserves a hashless ref even when it cannot resolve (helper is best-effort)", () => {
    // Anchor is past EOF — stripAnchorEcho + restoreIndent get undefined
    // and skip. The edit should pass through with no auto-fixes.
    const fileLines = ["only line"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: "999#Xy0│some anchor", // past EOF
      lines: ["new content"],
    };
    const r = normalizeEditPayload([edit], fileLines);
    // No display prefix in lines, no anchor echo, no indent restore (no anchor).
    expect(r.edits[0]?.lines).toEqual(["new content"]);
    expect(r.warnings).toEqual([]);
  });

  // Sanity check: computePublicLineChecksum is exposed; we use it in
  // broadRangeToInsert but never compare directly. This is a smoke test
  // that the imported helper still works.
  it("computePublicLineChecksum smoke test", () => {
    const cs = computePublicLineChecksum(["hello"], 1);
    expect(cs).toMatch(/^[A-Za-z0-9_-]{3}$/);
  });

  it("applies broadRangeToInsert when batch is [replace_text, single-hashline] — kilo CRITICAL regression", () => {
    // The bug: `edits.length === 1` check was off when a batch mixed
    // a `replace_text` edit with a single hashline edit. The total
    // length is 2, so the single-edit-batch gate was incorrectly
    // skipped, leaving the wide-range hashline edit un-converted
    // (and the user-facing wide-range warning suppressed). The fix
    // counts HASHLINE edits only (`hashlineEditCount === 1`).
    const fileLines = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const edit: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 6),
      lines: ["this is a brand new comment line"],
    };
    const replaceText: HashlineToolEdit = {
      op: "replace_text",
      pos: "",
      oldText: "a",
      newText: "A",
    };
    const r = normalizeEditPayload([replaceText, edit], fileLines);
    // The hashline edit IS converted to a prepend, because
    // hashlineEditCount === 1 (the replace_text edit doesn't count).
    const hashlineEdit = r.edits.find((e) => e.op === "prepend");
    expect(hashlineEdit).toBeDefined();
    expect(r.warnings.some((w) => w.includes("W_RANGE_TOO_BROAD"))).toBe(true);
    // replace_text is untouched.
    expect(r.edits.find((e) => e.op === "replace_text")).toBeDefined();
  });

  it("does NOT apply broadRangeToInsert when batch has 2+ hashline edits (preserve conflict detection)", () => {
    // With 2+ hashline edits, converting one of them to a prepend
    // would hide potential overlap conflicts. The fix preserves the
    // multi-hashline gate.
    const fileLines = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const edit1: HashlineToolEdit = {
      op: "replace",
      pos: ref(fileLines, 1),
      end: ref(fileLines, 6),
      lines: ["a brand new comment line"],
    };
    const edit2: HashlineToolEdit = {
      op: "append",
      pos: ref(fileLines, 8),
      lines: ["trailing"],
    };
    const r = normalizeEditPayload([edit1, edit2], fileLines);
    // No W_RANGE_TOO_BROAD — the auto-fix was correctly skipped.
    expect(r.warnings.some((w) => w.includes("W_RANGE_TOO_BROAD"))).toBe(false);
  });

  describe(" — drop per-line success warnings", () => {
    // Principle: "If we were able to handle it under the hood, and it was
    // fine, why are we warning the model about it?" The diff speaks for
    // itself. Warnings are only useful when the auto-fix couldn't fully
    // resolve the issue.

    describe("validateAndFixLines", () => {
      it("is silent when a single display prefix is stripped (success)", () => {
        const r = validateAndFixLines(["42abc│const x = 1"], 0);
        expect(r.lines).toEqual(["const x = 1"]);
        // No per-line warning on success.
        expect(r.warnings).toEqual([]);
      });

      it("is silent when MANY display prefixes are stripped (success, batched)", () => {
        // Pre- 12 lines with prefixes → 12 W_DISPLAY_PREFIX_IN_LINES warnings.
        // Post- silent on success.
        const lines = [
          "1abc│first",
          "2def│second",
          "3ghi│third",
          "4jkl│fourth",
          "5mno│fifth",
        ];
        const r = validateAndFixLines(lines, 0);
        expect(r.lines).toEqual([
          "first",
          "second",
          "third",
          "fourth",
          "fifth",
        ]);
        expect(r.warnings).toEqual([]);
      });

      it("is silent when a single diff-marker line is dropped (success)", () => {
        const r = validateAndFixLines(
          ["- 2    dropped marker", "real content"],
          0,
        );
        expect(r.lines).toEqual(["real content"]);
        expect(r.warnings).toEqual([]);
      });

      it("emits ONE summary when stripping leaves the edit empty (the failure case)", () => {
        // The only time W_DIFF_MARKER_IN_LINES should fire: when
        // stripping left us with nothing usable. A single prefix-only line
        // is no longer a failure — it's treated as a valid "replace with blank".
        // The emptyAfterStrip path is now exclusively triggered by
        // diff markers (or some other 100%-drop category). The caller
        // checks emptyAfterStrip and throws E_INVALID_PATCH.
        const r = validateAndFixLines(["- 2    only line"], 0);
        expect(r.emptyAfterStrip).toBe(true);
        // ONE summary, not per-line (there's only one line, but the
        // principle is one-summary-per-edit, never per-line).
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toMatch(/W_DIFF_MARKER_IN_LINES/);
      });

      it("does NOT emit a W_DISPLAY_PREFIX_IN_LINES warning for a single prefix-only line", () => {
        // The old behavior was: a line like "42abc│" with nothing
        // after the prefix was a stripping error → W_DISPLAY_PREFIX_IN_LINES.
        // The new behavior: it's a valid "replace with blank" line
        // and emits no warning.
        const r = validateAndFixLines(["42abc│"], 0);
        expect(r.emptyAfterStrip).toBe(false);
        expect(r.lines).toEqual([""]);
        expect(r.warnings).toEqual([]);
      });

      it("emits ONE summary when every line was a diff marker (the failure case)", () => {
        const r = validateAndFixLines(["- 2    only line"], 0);
        expect(r.emptyAfterStrip).toBe(true);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toMatch(/W_DIFF_MARKER_IN_LINES/);
      });

      it("warning text is simple — no 'lines should contain raw file content' architecture leak (diff-marker path)", () => {
        // The single prefix-only case is no longer a warning (it
        // becomes a "replace with blank" line). Use a diff marker
        // to exercise the failure-case warning text.
        const r = validateAndFixLines(["- 2    foo"], 0);
        // No "should contain raw file content" leak in the warning text.
        // The text describes the situation in the model's terms.
        expect(r.warnings[0]).not.toMatch(/should contain raw file content/);
        expect(r.warnings[0]).not.toMatch(/formatted read output/);
      });
    });

    describe("stripAnchorEcho", () => {
      it("emits a reminder when a leading echo is stripped (P3 modified)", () => {
        // P3 (modified): auto-fix happens silently in the
        // background, but the model gets a brief reminder per stripped
        // line. NOT a hard error.
        const r = stripAnchorEcho(
          ["line 1", "line 2"],
          "line 1",
          undefined,
          "append",
          0,
        );
        expect(r.lines).toEqual(["line 2"]);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toMatch(/\[W_ANCHOR_ECHO_STRIPPED\].*leading/);
      });

      it("emits two reminders when both leading and trailing echoes are stripped (P3 modified)", () => {
        const r = stripAnchorEcho(
          ["line 1", "new content", "line 3"],
          "line 1",
          "line 3",
          "replace",
          0,
        );
        expect(r.lines).toEqual(["new content"]);
        expect(r.warnings).toHaveLength(2);
        expect(r.warnings[0]).toMatch(/leading/);
        expect(r.warnings[1]).toMatch(/trailing/);
      });

      it("is silent when a single-line replace is `lines: [anchor]` (no-op, no strip)", () => {
        const r = stripAnchorEcho(
          ["line 1"],
          "line 1",
          undefined,
          "replace",
          0,
        );
        // The single-line case doesn't strip — the result is unchanged.
        expect(r.lines).toEqual(["line 1"]);
        expect(r.warnings).toEqual([]);
      });
    });
  });
});
