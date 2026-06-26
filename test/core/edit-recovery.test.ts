import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { tryRecovery } from "../../src/edit-recovery";

describe("tryRecovery — in-memory byte-level matching", () => {
  it("matches exact text", () => {
    const buffer = Buffer.from("hello world\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "hello",
      newText: "goodbye",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recoveredText).toBe("goodbye world\n");
      expect(result.strategy).toBe("exact");
    }
  });

  it("matches with CRLF normalization (file has CRLF, needle has LF)", () => {
    const buffer = Buffer.from("hello\r\nworld\r\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "hello\nworld",
      newText: "goodbye",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recoveredText).toBe("goodbye\r\n");
    }
  });

  it("matches with LF→CRLF normalization (file has LF, needle has CRLF)", () => {
    const buffer = Buffer.from("hello\nworld\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "hello\r\nworld",
      newText: "goodbye",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recoveredText).toBe("goodbye\n");
    }
  });

  it("matches with trailing whitespace tolerance (trimmed)", () => {
    const buffer = Buffer.from("hello   \nworld\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "hello\nworld",
      newText: "goodbye",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recoveredText).toBe("goodbye\n");
    }
  });

  it("returns failure when oldText is empty", () => {
    const buffer = Buffer.from("hello\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "",
      newText: "goodbye",
    });
    expect(result.success).toBe(false);
  });

  it("returns failure when oldText not found anywhere", () => {
    const buffer = Buffer.from("hello world\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "DOES_NOT_EXIST",
      newText: "goodbye",
    });
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.reason).toContain("not found");
    }
  });

  it("returns ambiguous when oldText appears multiple times", () => {
    const buffer = Buffer.from("hello\nhello\nworld\n", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "hello",
      newText: "goodbye",
    });
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.reason).toContain("ambiguous");
    }
  });
});

describe("tryRecovery — defensive guards ", () => {
  it("returns failure when rawBuffer is empty", () => {
    const buffer = Buffer.from("", "utf-8");
    const result = tryRecovery({
      rawBuffer: buffer,
      oldText: "hello",
      newText: "goodbye",
    });
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.reason).toContain("empty");
    }
  });
});
