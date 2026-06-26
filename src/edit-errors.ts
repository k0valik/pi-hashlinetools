/**
 * Error code formatting for hashline edits.
 *
 * Every user-facing error from the edit pipeline is built via `formatError`
 * so the format stays consistent:
 *
 *   - no context  → `"[CODE] message"`
 *   - with context → `"[CODE] message\n<context>"`
 *
 * `context` is opaque — callers control its internal newlines.
 *
 * An `ERROR_CODES` enum could be introduced in the future to replace the
 * current string-based error codes; the format string produced here will not
 * change.
 */
export function formatError(
  code: string,
  message: string,
  context?: string,
): string {
  const head = `[${code}] ${message}`;
  return context ? `${head}\n${context}` : head;
}
