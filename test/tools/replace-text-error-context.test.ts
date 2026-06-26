import { describe, expect, it } from "vitest";
import { applyReplaceTextEdits } from "../../src/edit";

describe("applyReplaceTextEdits - error context ", () => {
  it("includes match line numbers in E_REPLACE_TEXT_NOT_FOUND hint", () => {
    // 0 matches: the error should include the closest partial matches
    // (whitespace- and case-insensitive) so the model can refine its
    // oldText. We use a unique-looking oldText that doesn't appear, and
    // check the error includes the partial-match hint with line numbers.
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon";
    let caught: Error | undefined;
    try {
      applyReplaceTextEdits(
        content,
        [
          {
            op: "replace_text",
            pos: "",
            oldText: "alpha-bravo-charlie", // not in file
            newText: "REPLACED",
          },
        ],
        "test.txt",
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[E_REPLACE_TEXT_NOT_FOUND]");
    // The hint should mention "Closest partial matches" (the new
    // context line added in ).
    expect(caught!.message).toContain("Closest partial matches");
  });

  it("includes match line locations in E_REPLACE_TEXT_NOT_UNIQUE", () => {
    // N>1 matches: the error should include the line numbers where
    // each match starts.
    const content = "foo bar\nbaz\nfoo bar\nqux\nfoo bar";
    let caught: Error | undefined;
    try {
      applyReplaceTextEdits(
        content,
        [
          {
            op: "replace_text",
            pos: "",
            oldText: "foo bar",
            newText: "REPLACED",
          },
        ],
        "test.txt",
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[E_REPLACE_TEXT_NOT_UNIQUE]");
    expect(caught!.message).toContain("Match locations: lines 1, 3, 5");
  });

  it("includes a partial-match hint context when partial matches exist", () => {
    // Most "no match" errors will have some partial-match line. We
    // verify the context structure is present. The needle "alphx" is a
    // 1-char typo from "alpha" — LCS of 4 chars ("alph"), which is
    // above the minScore floor (min(4, 5) = 4) and so the line gets
    // reported as a partial match.
    const content = "alpha\nbeta\ngamma";
    let caught: Error | undefined;
    try {
      applyReplaceTextEdits(
        content,
        [
          {
            op: "replace_text",
            pos: "",
            oldText: "alphx", // 1-char typo of "alpha"
            newText: "REPLACED",
          },
        ],
        "test.txt",
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[E_REPLACE_TEXT_NOT_FOUND]");
    // "alpha" is a partial match for "alphx" (LCS = 4 chars).
    expect(caught!.message).toContain("Closest partial matches");
  });

  it("happy path: 1 match succeeds with no error", () => {
    const result = applyReplaceTextEdits(
      "hello world",
      [
        {
          op: "replace_text",
          pos: "",
          oldText: "world",
          newText: "everyone",
        },
      ],
      "test.txt",
    );
    expect(result).toBe("hello everyone");
  });

  it("truncates the match-locations context to 5 entries with a 'first N of M' suffix", () => {
    // Create a file with the same 5-char string on 7 different lines.
    const lines = Array.from({ length: 7 }, () => "alpha beta");
    const content = lines.join("\n");
    let caught: Error | undefined;
    try {
      applyReplaceTextEdits(
        content,
        [
          {
            op: "replace_text",
            pos: "",
            oldText: "alpha beta",
            newText: "REPLACED",
          },
        ],
        "test.txt",
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[E_REPLACE_TEXT_NOT_UNIQUE]");
    // 7 matches; we show the first 5 lines, with a "first 5 of 7" suffix.
    expect(caught!.message).toContain("Match locations: lines 1, 2, 3, 4, 5");
    expect(caught!.message).toContain("first 5 of 7");
  });
});
