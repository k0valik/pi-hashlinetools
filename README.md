# pi-hashlinetools

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that **replaces the built-in `read`, `edit`, `write`, and `undo` tools** with a hash-anchored, line-endpoint-reference workflow.

Every line returned by `read` carries a single-letter checksum and the line content. Edits reference these endpoint lines by their full text, so the tool can detect drift between the model's view of the file and reality — and reject outdated changes before they reach the file.

Standalone fork of the hashline-edit extension, extracted from the `k0valik/pi-packages` monorepo. Vendored from the open-source [`cgint/pi-line-edit`](https://github.com/cgint/pi-line-edit) fork.

> **Architecture documentation:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) covers the full internal design — module layout, data flows, 4-layer stale anchor recovery, edit pipeline stages, validation and safety systems, atomic writing, and the complete error/warning code tables.

---

## Why

The stock `edit` tool requires exact old-text matches. That's brittle when the file has changed since the model last read it, and it leaves the model guessing about what the file actually looks like. Hashline editing fixes this by anchoring every line to a content-derived checksum.

This extension goes further: it requires the model to copy the **full endpoint line** (line number + checksum + content) from `read` output into the `edit` call. This eliminates two common failure modes:

- **Forgetting the `end` anchor** when replacing a range — both endpoints must be full lines, so the model can't omit one.
- **Stale-anchor copy-paste** — the embedded content is checked against the current file, so a drift between read and edit is detected immediately. A 4-layer recovery system handles common drift patterns (fuzzy relocate, hash-index relocate) gracefully rather than failing outright.

---

## How It Works

### `read` — checked endpoint output

Text files are returned with a `LINEc│content` prefix on every line, where `c` is a single-letter checksum (a–z):

```text
 8k│function hello() {
 9m│  console.log("world");
10p│}
```

- `LINE` — 1-indexed line number, left-padded within each block so the `c│` column aligns.
- `c` — single-letter checksum, derived from an FNV-1a hash of the line plus its immediate neighbors. Distant edits don't invalidate anchors; nearby edits do.
- `│content` — the actual line content (U+2502 box-drawing character as separator).

Optional parameters:
- `offset` — start reading from this line (1-indexed).
- `limit` — maximum number of lines to return.
- `raw: true` — return plain text without the `LINEc│` prefix. Use this for exploration reads you don't plan to edit (saves tokens).

Images (JPEG, PNG, GIF, WebP) pass through as attachments. Binary files and directories are rejected with descriptive errors. Empty files return a clear advisory pointing to `write`.

### `edit` — full-endpoint-ref modifications

Each edit replaces an inclusive range with new content. Both endpoints must be **full read-output endpoint lines** copied verbatim from a recent `read` or edit result:

```json
{
  "path": "src/main.ts",
  "edits": [
    {
      "range": [
        " 9m│  console.log(\"world\");",
        " 9m│  console.log(\"world\");"
      ],
      "lines": ["  console.log('pi-hashline-edit');"],
      "intent": "Update the example greeting output.",
      "rationale": "The README demonstrates replacing exactly one read-output endpoint line."
    }
  ]
}
```

**Strict ref requirements:**
- The `range` values must be full endpoint lines (must contain `│` or `|`).
- Compact refs like `"9m"` and bare line numbers like `"9"` are rejected with `[E_FULL_REF_REQUIRED]`.
- The embedded content must match the current file content; mismatch yields `[E_LINE_CONTENT_MISMATCH]` (unless the 4-layer recovery resolves it — see [ARCHITECTURE.md](./ARCHITECTURE.md#4-layer-stale-anchor-recovery)).
- `intent` and `rationale` are **optional** fields surfaced in the tool call render for provenance.

**Stale-context tolerance:** if the checksum letter has drifted but the content still matches, the edit proceeds with a `[W_STALE_CONTEXT]` warning. This handles the common case where neighboring lines have changed but the target line itself hasn't.

Other validation:
- 1–3 edits per call. Larger changes must be split across multiple `edit` calls (`[E_TOO_MANY_EDITS]`).
- All edits apply bottom-up from a single baseline view of the file.
- Edits that would empty a file with more than 50 lines are rejected with `[E_WOULD_EMPTY]`.

### `write` — full-file replacement

Wraps the built-in `write` tool. Accepts optional `intent` and `rationale` fields for provenance metadata (surfaced in the tool call render):

```json
{
  "path": "src/new-file.ts",
  "content": "export const greeting = 'hello';\n",
  "intent": "Create the greeting module.",
  "rationale": "Initial scaffold for the new feature."
}
```

Use this for creating new files or for wholesale rewrites where `edit` would require too many operations. For modifying an existing file, prefer `edit` — it's safer.

### `undo` — revert the last edit

Reverts the most recent edit (within the last 3 conversation turns). Useful when the model realizes an edit was wrong before the context window scrolls away.

### Diff output

Edit results return fresh checked refs in a clean line-numbered diff:

```diff
 8k│function hello() {
-9m│  console.log("world");
+9v│  console.log("pi-hashline-edit");
10p│}
```

- Context lines: ` LINEc│content` (unchanged)
- Removed lines: `-LINEc│content` (checksum from the removed line)
- Added lines: `+LINEc│content` (fresh checksum for the new state)

---

## Design Decisions

- **Stale anchors have a 4-layer recovery system.** The runtime first tries exact content match, then fuzzy relocate (±40 lines), then hash-index relocation by stale checksum letter, then a hard error with fresh anchors. See [ARCHITECTURE.md](./ARCHITECTURE.md#4-layer-stale-anchor-recovery) for details.
- **Asymmetric shifts are rejected.** If the start and end of a range edit relocate by different offsets, the edit is blocked with `[E_ASYMMETRIC_SHIFT]` — the content between the endpoints was structurally modified.
- **Strict patch content.** If `lines` contains `LINEc│` display prefixes or diff `+`/`-` markers, the edit is rejected with `[E_INVALID_PATCH]`. Single-letter bare prefixes (like `f│`) that match file checksums trigger a warning but are not rejected.
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved; hard-linked files (nlink > 1) are updated in place. File permissions are preserved across atomic renames.
- **Per-file mutation queue.** Edits queue by canonical write target, so concurrent edits through different symlink paths serialize onto the same underlying file.
- **Post-edit verification.** After writing, the file is read back and compared byte-for-byte. On mismatch, the original content is restored and `[E_WRITE_VERIFY]` is raised.
- **BOM and line-ending preservation.** The read/edit pipeline normalizes to LF internally but restores the file's original BOM and line endings on write.

---

## Hashing

The checksum letter is derived from a 32-bit FNV-1a hash (inline implementation, no native dep) of the line plus its immediate neighbors. The 8-bit hash byte is reduced modulo 26 to a single lowercase letter (`a`–`z`).

- **Distant edits are stable.** Changing line 100 does not invalidate the anchor on line 1.
- **Nearby edits are detected.** Changing line 5 invalidates anchors on lines 4, 5, and 6 (because their neighbor context changed). The model must re-read to get fresh anchors for nearby edits.

The previous upstreams used a 2-character hex alphabet (`0-9 A-F`) before the single-letter reduction. The single-letter form is token-cheaper and equally collision-resistant for the use case (8 bits of context, not 8 bits of line content).

---

## Installation

Clone this repository:

```bash
git clone <repo-url> ~/.pi/extensions/pi-hashlinetools
cd ~/.pi/extensions/pi-hashlinetools
pnpm install
```

Then register the extension in your pi session by adding `./pi-hashlinetools/index.ts` to your `package.json`'s `pi.extensions` array, or use `/reload` after installing.

> **Prerequisites:** [Node.js](https://nodejs.org) ≥ 22, [pnpm](https://pnpm.io), and the required peer packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `@sinclair/typebox`) available in your pi runtime.

---

## Provenance

This extension is a synthesis of three open-source forks of a single idea:

1. **[oh-my-pi](https://github.com/can1357/oh-my-pi)** by [can1357](https://github.com/can1357) — the original hashline concept and implementation.
2. **[RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit)** — the first pi-coding-agent extension. Introduced the multi-op edit schema (`replace`/`append`/`prepend`/`replace_text`) and the 16-character `ZPMQVRWSNKTXJBYH` hash alphabet.
3. **[JerryAZR/pi-hashline-edit](https://github.com/JerryAZR/pi-hashline-edit)** — a fork that trimmed the schema to a single `{ range, lines }` shape, replaced the hash alphabet with hex, added inline FNV-1a with line+neighbor context, introduced the `│` content separator, added the undo tool, and built a 3-tier stale-anchor recovery (exact → fuzzy relocate → 3-way merge).
4. **[cgint/pi-line-edit](https://github.com/cgint/pi-line-edit)** — a fork of Jerry's that pivoted the ref shape to **full endpoint lines** (`LINEc│content`), making the model copy the line content into the edit request. This eliminates the "forgot `end`" failure mode and lets the runtime validate content rather than just position. Also added a `write` tool with provenance metadata.

The version in this directory is based on cgint's `pi-line-edit` at commit `d003425`, extracted from the `k0valik/pi-packages` monorepo at the `feature/hashline-base` branch.

The vendored cgint/Jerry analysis documents (`upstream_docs/*.md`, `upstream_docs/*.py`, `profiling/`) are kept as-is for reference. They document the failure modes the upstream authors discovered and the design tradeoffs they made. **Do not delete these** — they encode lessons learned that should not be re-discovered by trial and error.

---

## Development

Requires [Node.js](https://nodejs.org) ≥ 22 and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm exec vitest run
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

### Test notes

- 225 tests across 29 files. Tests use `vitest`. Mirror the source layout: `test/core/` for hashline primitives, `test/tools/` for tool behavior, `test/integration/` for end-to-end flows, `test/support/` for temp-file helpers.

### Architecture guardrails

- Don't bypass `src/fs-write.ts`; atomic writes are part of the safety contract.
- Preserve stale-anchor recovery semantics unless explicitly redesigning the protocol.
- Don't introduce autocorrection heuristics into `applyHashlineEdits`. The runtime must reject or warn, never silently patch.
- Keep `read`, `edit`, prompt text, and tests in sync whenever the line-endpoint format changes.

---

## License

[MIT](LICENSE). Vendored from MIT-licensed upstreams; see the LICENSE file and the upstream repos for the chain of attribution.
