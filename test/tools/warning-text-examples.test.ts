/**
 *  ( plan): fix the example text in warning messages.
 * The bare-ref warning at edit-strategies.ts:215 used "42f│" as the
 * example, but the read tool emits 3-character URL-safe base64
 * hashes (e.g. "42abc│"). The warning text was teaching the model
 * a hash format the tool never actually produces.
 *
 * The fix: update the example to "42abc│" to match the read tool's
 * actual output. The schema still accepts all 4 legacy hash forms
 * (3-char base64 with/without `#`, 2-char hex, 1-letter) — the
 * change is documentation only, not behavior.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("warning text examples ", () => {
  it("the bare-ref warning in edit-strategies.ts uses 3-char base64 in the example", () => {
    // The whole point of the example is to teach the model what a
    // full endpoint ref looks like. The example should match what
    // the read tool actually produces.
    const path = fileURLToPath(
      new URL("../../src/edit-strategies.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    // The example should match the read tool's actual output format:
    // line number + 3-char base64 + pipe + content. (The source uses
    // a backtick-delimited template literal, so the example string
    // is wrapped in `"..."` quotes inside the template.)
    expect(source).toMatch(/"42[a-zA-Z0-9_-]{3}│const value = 1;"/);
    // The old broken example must be gone.
    expect(source).not.toMatch(/"42f│const value = 1;"/);
  });
});
