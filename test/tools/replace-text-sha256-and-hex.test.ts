/**
 *  — replace_text error/warning context
 *
 * Two new diagnostics on the `replace_text` path:
 *
 *  1. The 0-match `E_REPLACE_TEXT_NOT_FOUND` error includes a short
 *     `File SHA-256: <16-hex>` prefix in the context so the model can
 *     confirm "yes, the file I'm looking at matches what the tool saw."
 *     Borrowed from `pi-robust-edit`'s `findInBuffer` error path; replaces
 *     the 0-match context that today only has the partial-match hint.
 *
 *  2. The `W_AUTO_RECOVERY` warning (fired on a non-exact but still
 *     successful `tryRecovery`) includes a hex preview of the first 16
 *     bytes of the matched region. The strategy name (`lf-normalized`,
 *     `trimmed`, etc.) is intentionally NOT included — the previous UX
 *     pass hid it. The bytes are visible, the strategy is hidden.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyReplaceTextEdits } from "../../src/edit";

const HEX_16_RE = /File SHA-256: [0-9a-f]{16}/;
const HEX_PREVIEW_RE = /hex: [0-9a-f ]{8,47}/;

describe("applyReplaceTextEdits - SHA-256 in 0-match error ", () => {
  it("E_REPLACE_TEXT_NOT_FOUND includes a 16-char File SHA-256 prefix when rawBuffer is provided", () => {
    // The content here is the test buffer; rawBuffer mirrors it. The
    // expected SHA-256 prefix is computed independently via node:crypto
    // so this test does not depend on the helper under test.
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon";
    const rawBuffer = Buffer.from(content, "utf-8");
    const expected = createHash("sha256")
      .update(rawBuffer)
      .digest("hex")
      .slice(0, 16);

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
        rawBuffer,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[E_REPLACE_TEXT_NOT_FOUND]");
    expect(caught!.message).toMatch(HEX_16_RE);
    expect(caught!.message).toContain(`File SHA-256: ${expected}`);
  });

  it("E_REPLACE_TEXT_NOT_FOUND omits the SHA-256 line when rawBuffer is not provided", () => {
    // Without rawBuffer the tool can't compute the hash, so the prefix
    // is omitted (not stubbed with a placeholder). The error still
    // fires, but the SHA-256 line is absent.
    const content = "alpha\nbeta\ngamma";
    let caught: Error | undefined;
    try {
      applyReplaceTextEdits(
        content,
        [
          {
            op: "replace_text",
            pos: "",
            oldText: "alpha-bravo-charlie",
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
    expect(caught!.message).not.toContain("File SHA-256:");
  });

  it("E_REPLACE_TEXT_NOT_UNIQUE also includes the SHA-256 prefix", () => {
    // The duplicate-match path also benefits from the file hash. The
    // model can verify it's not looking at a stale file.
    const content = "foo bar\nbaz\nfoo bar\nqux\nfoo bar";
    const rawBuffer = Buffer.from(content, "utf-8");
    const expected = createHash("sha256")
      .update(rawBuffer)
      .digest("hex")
      .slice(0, 16);

    let caught: Error | undefined;
    try {
      applyReplaceTextEdits(
        content,
        [{ op: "replace_text", pos: "", oldText: "foo bar", newText: "X" }],
        "test.txt",
        rawBuffer,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("[E_REPLACE_TEXT_NOT_UNIQUE]");
    expect(caught!.message).toContain(`File SHA-256: ${expected}`);
  });
});

describe("applyReplaceTextEdits - hex context in W_AUTO_RECOVERY warning ", () => {
  it("W_AUTO_RECOVERY includes a hex preview of the first 16 matched bytes on a trimmed match", () => {
    // The file has trailing whitespace on the first line; oldText does
    // not. tryRecovery succeeds via the `trimmed` strategy and emits
    // a warning that includes the hex of the actual file bytes that
    // matched. The hex preview is the only "leak" — the strategy name
    // is hidden (per the  UX cleanup).
    //
    // Shape: oldText = "line1\nline2" (no space) vs content = "line1 \nline2\n"
    // (space after `line1`). String.indexOf fails for the oldText, but
    // byte-level trimmed match succeeds.
    const content = "line1 \nline2\n";
    const rawBuffer = Buffer.from(content, "utf-8");

    const warnings: string[] = [];
    const result = applyReplaceTextEdits(
      content,
      [
        {
          op: "replace_text",
          pos: "",
          oldText: "line1\nline2",
          newText: "changed",
        },
      ],
      "test.txt",
      rawBuffer,
      warnings,
    );
    // Edit succeeded.
    expect(result).toBe("changed\n");
    // Warning fired exactly once, and is the recovery warning.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[W_AUTO_RECOVERY]");
    // Hex preview is in the warning, prefixed with "hex:".
    expect(warnings[0]).toMatch(HEX_PREVIEW_RE);
    // The hex preview reflects the actualOldBytes the recovery matched
    // against in the file. For this input the recovery is on the
    // trimmed string `"line1 \nline2"` (12 bytes — the trailing \n
    // of `line2` is not part of the matched needle, the file's matched
    // region is the second line's content plus the trailing space
    // from `line1 `). Verify the warning contains the hex of that
    // matched region: 6c 69 6e 65 31 20 0a 6c 69 6e 65 32.
    const expectedMatched = "6c 69 6e 65 31 20 0a 6c 69 6e 65 32";
    expect(warnings[0]).toContain(expectedMatched);
  });

  it("W_AUTO_RECOVERY hex preview does NOT include the strategy name", () => {
    // UX cleanup from  hid the strategy name (lf-normalized,
    // trimmed, etc.) on the grounds it leaked internal architecture.
    // The hex preview replaces that signal with bytes the model can
    // actually verify against.
    const content = "line1 \nline2\n";
    const rawBuffer = Buffer.from(content, "utf-8");
    const warnings: string[] = [];
    applyReplaceTextEdits(
      content,
      [
        {
          op: "replace_text",
          pos: "",
          oldText: "line1\nline2",
          newText: "changed",
        },
      ],
      "test.txt",
      rawBuffer,
      warnings,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(
      /strategy: (exact|trimmed|lf-normalized|crlf-normalized)/,
    );
  });
});
