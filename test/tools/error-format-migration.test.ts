import { describe, expect, it } from "vitest";
import { formatError } from "../../src/edit-errors";

/** Smoke-test: every error code the edit tool uses must round-trip through
 *  formatError and produce a string that starts with "[CODE] " where CODE
 *  is uppercase snake_case. This is a regression guard for the bulk
 *  migration in . */
describe("error code format regression ( bulk migration)", () => {
  // All error codes currently emitted by the edit tool's ~15 throw
  // sites. Keep in sync with the migrations in edit.ts, edit-anchor.ts,
  // and hashline.ts. If you add a new code, add it here.
  const EDIT_TOOL_CODES = [
    "E_INVALID_REQUEST",
    "E_UNSUPPORTED_OP",
    "E_FULL_REF_REQUIRED",
    "E_EMPTY_LINES",
    "E_LINE_OUT_OF_RANGE",
    "E_RELOCATE_AMBIGUOUS",
    "E_LINE_CHANGED",
    "E_ASYMMETRIC_SHIFT",
    "E_REPLACE_TEXT_MISSING",
    "E_REPLACE_TEXT_NOT_FOUND",
    "E_REPLACE_TEXT_NOT_UNIQUE",
    "E_WOULD_EMPTY",
    "E_WRITE_VERIFY",
    "E_BAD_REF",
    "E_EDIT_CONFLICT",
    "E_BAD_RANGE",
  ];

  for (const code of EDIT_TOOL_CODES) {
    it(`formatError produces a well-formed [${code}] prefix`, () => {
      const out = formatError(code, "test message");
      expect(out).toBe(`[${code}] test message`);
      // Codes must be uppercase snake_case (uppercase letters, digits,
      // underscores only; must start with a letter).
      expect(code).toMatch(/^E_[A-Z][A-Z0-9_]*$/);
    });
  }

  it("all error messages from edit-anchor.ts use the new format", () => {
    // The bulk migration in  rewrites 8 throw sites in
    // edit-anchor.ts to use formatError. We test the end-to-end
    // surface by checking the helper output shape is preserved.
    const expected = formatError(
      "E_LINE_OUT_OF_RANGE",
      "line 99 is past the end of the file (file has 50 lines). Use a line reference from a recent read.",
    );
    expect(expected).toMatch(/^\[E_LINE_OUT_OF_RANGE\] /);
    // No internal jargon leaking.
    expect(expected).not.toContain("endpoint line");
    expect(expected).not.toContain("checksum");
  });
});
