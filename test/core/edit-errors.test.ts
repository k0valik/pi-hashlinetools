import { describe, expect, it } from "vitest";
import { formatError } from "../../src/edit-errors";

describe("formatError", () => {
  it("builds '[CODE] message' shape with no context", () => {
    expect(formatError("E_TEST", "something went wrong")).toBe(
      "[E_TEST] something went wrong",
    );
  });

  it("appends context on a newline when provided", () => {
    expect(
      formatError("E_TEST", "something went wrong", "file: foo.txt\nline: 12"),
    ).toBe("[E_TEST] something went wrong\nfile: foo.txt\nline: 12");
  });

  it("treats empty string context as 'no context'", () => {
    expect(formatError("E_TEST", "msg", "")).toBe("[E_TEST] msg");
  });

  it("preserves special characters in message verbatim", () => {
    expect(formatError("E_X", 'got "foo\\nbar"')).toBe('[E_X] got "foo\\nbar"');
  });

  it("does not impose a maximum message length", () => {
    const long = "x".repeat(500);
    const out = formatError("E_LONG", long);
    expect(out).toBe(`[E_LONG] ${long}`);
  });

  it("does not prefix the code with a second bracket on the context line", () => {
    // The context is opaque — the caller can put a [SOMETHING] inside it
    // without us re-wrapping it. This is what lets us nest formatError
    // outputs in the medley warning emission.
    const out = formatError("E_OUTER", "msg", "[E_INNER] nested");
    expect(out).toBe("[E_OUTER] msg\n[E_INNER] nested");
  });
});
