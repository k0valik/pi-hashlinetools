# pi-hashline-edit Architecture

## Overview

This extension replaces the built-in `read`, `edit`, `write`, and `undo` tools of
[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) with a hash-anchored,
line-endpoint-reference workflow. Every line returned by `read` carries a checksum derived
from the line plus its immediate neighbors. Edits reference these endpoint lines by their
full text (line number + checksum + content), so the runtime can detect drift between the
model's view of the file and reality — and reject outdated changes before they reach the
file.

## Module Layout

```
index.ts                          — Entry point: registers all 4 tools + turn tracking
src/
  hashline.ts                     — Core hashline engine (hash compute, parse, apply)
  edit.ts                         — Edit tool definition (schema, validation, anchor resolution, execution)
  read.ts                         — Read tool definition (hashline-formatted output)
  write.ts                        — Write tool definition (validates, delegates to built-in)
  undo.ts                         — Undo tool definition (in-memory stack, turn-window check)
  edit-diff.ts                    — Diff generation (structuredPatch), line-ending/BOM handling
  edit-response.ts                — Response builders (noop/changed, metrics)
  line-ref.ts                     — Public checksum (FNV-1a 8-bit → modulo 26 → a-z), parse/format
  file-kind.ts                    — MIME sniffing, image/null-byte detection, streaming UTF-8 decode
  fs-write.ts                     — Atomic write (temp + rename), symlink resolution, hard-link awareness
  path-utils.ts                   — Path resolution (~ expansion, cwd-relative)
  snapshot.ts                     — File snapshot fingerprint (v1|path|mtime|size)
  runtime.ts                      — throwIfAborted helper
  package-info.ts                 — Package name/version constant
tool-descriptions/
  read.md                         — Full read tool prompt text
  edit.md                         — Full edit tool prompt text
  write.md                        — Full write tool prompt text
  undo.md                         — Full undo tool prompt text
  read-snippet.md                 — Compact read description for tool-use context
  edit-snippet.md                 — Compact edit description
  write-snippet.md                — Compact write description
  read-guidelines.md              — Additional read guidelines
test/
  core/                           — Tests for hashline primitives (parse, hash, resolve, apply, recovery)
  tools/                          — Tests for tool behavior (edit, read, write, undo, preview, queue)
  integration/                    — End-to-end flow tests (chained anchors, stale positions)
  extension/                      — Extension registration tests
  support/                        — Test fixture helpers
```

## Data Flow

### Read

```
registerReadTool()
  └─ execute()
      ├─ resolveToCwd(path, cwd) — expand ~, make absolute
      ├─ fsAccess(R_OK) — file exists + readable guard
      ├─ loadFileKindAndText() — MIME-sniff, null-byte check, streaming UTF-8 decode
      │   ├─ kind === "directory" → list entries, error
      │   ├─ kind === "binary"    → error with mime description
      │   ├─ kind === "image"     → delegate to built-in createReadTool (inline display)
      │   └─ kind === "text"      → continue
      ├─ normalizeToLF(stripBom(text)) — LF normalization, BOM extraction
      ├─ formatHashlineReadPreview(normalized, { offset, limit, raw })
      │   ├─ raw: true → plain text (no LINEc│ prefix)
      │   └─ raw: false → LINEc│content with aligned line numbers
      ├─ truncation: DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES
      ├─ U+FFFD detection → warns about non-UTF-8 bytes
      └─ returns { content: [text], details: { snapshotId, nextOffset, metrics, package } }
```

### Edit

```
registerEditTool()
  └─ execute()
      ├─ assertEditRequest(params) — validates path (string) + edits (array, 1-3)
      ├─ normalizeEditItems(edits) — schema normalization:
      │   ├─ op="replace_text" → uses oldText/newText directly
      │   ├─ op="append"/"prepend" → extracts pos + lines
      │   └─ op="replace" (default) → extracts range[pos, end] + lines
      ├─ resolveToCwd(path, cwd)
      ├─ resolveMutationTargetPath(abspath) — symlink chain resolution
      ├─ withFileMutationQueue(targetPath) — serializes concurrent edits
      │   └─ inner:
      │       ├─ resolveEditTarget(abspath, path, R_OK | W_OK)
      │       │   ├─ fsAccess — file exists + writable
      │       │   ├─ loadFileKindAndText — only text files allowed
      │       │   └─ stripBom + normalizeToLF
      │       ├─ applyReplaceTextEdits — exact unique substring replacement (pre-hashline)
      │       ├─ anchorBareLineNumberEdits(hashlineEdits, text) — anchor resolution:
      │       │   ├─ replace_text edits → pass through
      │       │   ├─ append/prepend without pos → BOF/EOF handling (converted to replace)
      │       │   └─ for each hashline edit:
      │       │       └─ anchorPublicLineRef(ref, fileLines, ...) — 4-layer stale anchor recovery
      │       ├─ resolveEditAnchors(anchored.edits) — parse LINE#HH refs, validate hash chars
      │       ├─ applyHashlineEdits(normalized, resolved) — main edit engine
      │       ├─ post-edit verification (read back + compare, rollback on mismatch)
      │       ├─ buildPostEditAnchors(result, firstChangedLine, lastChangedLine)
      │       └─ buildChangedResponse / buildNoopResponse
```

### Write

```
registerWriteTool()
  └─ execute()
      ├─ assertWriteRequest(params) — validates path + content
      └─ delegates to built-in createWriteTool(ctx.cwd)
```

### Undo

```
registerUndoTool()
  └─ execute()
      ├─ getLastEdit() — in-memory { path, previousContent, turnIndex }
      ├─ check: MAX_UNDO_TURNS (3) window
      ├─ resolveEditTarget + loadFileKindAndText
      ├─ writeFileAtomically with original content
      ├─ clearLastEdit()
      └─ buildChangedResponse with reverse diff
```

## Core Engine: The Hashline

### Hash Computation (`src/hashline.ts:computeLineHash`)

```
FNV-1a 32-bit (inline, no native dependency)
Input = prevLine + NUL + currentLine + NUL + nextLine
          │           │                │
          │           │                └─ contributes to neighbor context
          │           └─ delimiter so "ab" + "c" ≠ "a" + "bc"
          └─ missing at file boundaries = empty string
Output = 2-char uppercase hex (DICT[hash & 0xFF])
       → publicChecksumFromHash maps this to a single lowercase a-z
         via: byte % 26 → alphabet index
```

Key properties:
- **Distant edits are stable**: changing line 100 does not invalidate the anchor on line 1
- **Nearby edits are detected**: changing line 5 invalidates anchors on lines 4, 5, and 6
- **Token-efficient**: single lowercase letter in tool output

### Anchor Format

| Context | Format | Example |
|---|---|---|
| Read output (normal) | `LINEc│content` | ` 9m│  console.log("world");` |
| Read output (raw) | (no prefix) | `  console.log("world");` |
| Edit range endpoint | `LINE#HH` (internal) | `9#F2` |
| Edit range endpoint (public) | `LINEc` (a-z checksum letter) | `9m` |
| Full endpoint ref | `LINEc│content` | ` 9m│  console.log("world");` |
| Diff context | ` LINEc│content` | ` 9m│  console.log("world");` |
| Diff removed | `-LINEc│content` | `-9m│  console.log("world");` |
| Diff added | `+LINEc│content (new)` | `+9v│  console.log("pi-hashline-edit");` |

## 5-Layer Stale Anchor Recovery

When the model sends a full endpoint ref like `" 9m│  console.log(\"world\");"` but the file has changed since the read, `anchorPublicLineRef()` (in `src/edit.ts`) applies up to 5 recovery layers:

### Layer 1: Exact content match at expected line
If the content hint (text after `│`) matches line N's current content:
- Checks the public checksum letter only as a warning trigger (`[W_STALE_CONTEXT]` if mismatch)
- **Proceeds** regardless — the content is authoritative

### Layer 2-3: Fuzzy relocate by content
If line N's content doesn't match the hint, search ±40 lines (`FUZZY_SEARCH_RADIUS`) for matching content:
- **Single match** → relocate with `[W_STALE_CONTEXT]` warning
- **Multiple matches** → ambiguous, reject with `[E_LINE_CONTENT_MISMATCH]`

### Layer 4: Hash-index relocation
If no content hint is present (bare `LINEc` form), search the entire file for lines matching the stale public checksum letter:
- **Single match** → relocate with `[W_HASH_RELOCATE]` warning
- **Multiple/none** → fall through to hard error

### Asymmetric-shift rejection
For multi-line range edits (`end` anchor), if start and end relocate by different offsets, the edit is rejected with `[E_ASYMMETRIC_SHIFT]` — the content between the endpoints was structurally modified.

### Layer 5: Byte-level relocation
When text-line relocation fails (content shifted beyond ±40 lines, or encoding quirks cause normalized-text mismatch), `tryByteRelocate()` (in `src/edit.ts`) searches the **raw file bytes** for the content hint:
- Scans the entire raw `Buffer` (no radius limit) using `Buffer.indexOf()`
- Only accepts matches at line-start positions (after `\n` or at file start / after BOM)
- **Single match** → relocate with `[W_BYTE_RELOCATE]` warning
- **Multiple/none** → fall through to hard error

The raw buffer is read alongside the normalized text in `resolveEditTarget()` via `readFile()` and threaded through `anchorBareLineNumberEdits()` → `anchorPublicLineRef()`.

### Asymmetric-shift rejection (continued)
For multi-line range edits with byte-relocated anchors, the same asymmetric-shift check applies: if start and end relocate by different offsets, the edit is rejected with `[E_ASYMMETRIC_SHIFT]`.

### Byte-level fallback for replace_text
When `applyReplaceTextEdits()` fails to find `oldText` in the normalized content, it falls back to searching the raw bytes (`rawBuffer.indexOf()`). If found uniquely, the replacement is applied at the byte level and the result re-normalized before continuing.

### Fallback
If none of the 5 layers succeed: hard error with `[E_LINE_CONTENT_MISMATCH]` (if content present and misaligned) or `[E_RANGE_OOB]` (if line out of range).

## Edit Application Pipeline

### 1. Schema Validation (`assertEditRequest` + AJV)
- Top-level: `path` (non-empty string), `edits` (array, 1-3 entries)
- Per-edit: TypeBox pattern match for endpoint refs (`^\s*[>+\-]*\s*\d+(?:[a-z]|#[0-9A-F]{2})\s*[│|]`)
- `maxEditsPerCall` guard (default: 3)

### 2. Normalize Edit Items (`normalizeEditItems`)
Converts tool-schema shapes to `HashlineToolEdit[]`:
- `range: [start, end]` → `pos` + `end`
- `op: "replace"` (default) — range-based line replacement
- `op: "append"` — insert after anchor line (converted to replace internally)
- `op: "prepend"` — insert before anchor line (converted to replace internally)
- `op: "replace_text"` — exact unique substring replacement (separate code path)

### 3. Anchor Resolution (`anchorBareLineNumberEdits`)
Resolves BOF/EOF (append/prepend without pos) and runs the 4-layer recovery for each anchor.

### 4. Internal Anchor Parsing (`resolveEditAnchors`)
Parses `LINE#HH` format with strict validation:
- Line number ≥ 1
- Hash exactly 2 uppercase hex characters (0-9 A-F)
- Rejects wrong separators (`LINE:...`), missing hashes

### 5. Hash Validation + Application (`applyHashlineEdits`)
- Clones all edits (immutable working copy)
- Builds a line index (file lines + character offsets)
- Validates every anchor: `computeLineHash(fileLines, line-1)` vs `expected hash`
- On mismatch: `formatMismatchError` generates a snippet with fresh anchors (marked `>>>`) for immediate retry
- On match: `resolveEditToSpan` maps to character offsets (start, end, replacement)
- **Noop detection**: if replacement matches current content, marks as noop
- **Boundary duplication check**: warns if replacement starts/ends with a line that matches the neighboring surviving line
- **Duplicate target detection**: warns when multiple edits target the same anchor
- **Span deduplication**: exact duplicate spans (`replace:start:end:replacement`) are deduplicated
- **Conflict detection**: overlapping spans → `[E_EDIT_CONFLICT]`
- **Bottom-up application**: spans sorted by `end` descending, then by index ascending, so earlier spans don't shift later ones
- **Changed line range computation**: character-level diff → first/last changed line numbers

### 6. Full-File Deletion Guard
If the result is empty and the original has > 50 lines, rejects with `[E_WOULD_EMPTY]`.

### 7. File Writing (`writeFileAtomically`)
- Temp file (`.tmp-<UUID>`) in the same directory, written with `flag: "wx"`
- `rename(tempPath, targetPath)` — atomic on the same filesystem
- Skips atomic rename for hard-linked files (nlink > 1) — writes in-place
- Preserves original file mode

### 8. Post-Edit Verification
Reads back the written file and compares byte-for-byte. On mismatch, rolls back by restoring the original content. Surfaces `[E_WRITE_VERIFY]` on failure.

### 9. Post-Edit Anchors
Returns a block of fresh `LINEc│content` refs covering the changed region ±4 lines, so the model can chain subsequent edits without re-reading.

## TUI Rendering Architecture

All 4 tools implement custom `renderCall` and `renderResult` methods for TUI display:

### Edit Tool
- **renderCall**: Shows path, provenance (intent/rationale), and a live async diff preview
- **renderResult**: Shows colored diff (green for additions, red for deletions), change summary (`X insertions(+), Y deletions(-)`), post-edit anchors, and warnings
- **Async preview**: `computeEditPreview()` runs on a background promise; preview is cached by `argsKey` and invalidated when inputs change. Uses `previewGeneration` counter for stale-response rejection.

### Read Tool
- Uses the default tool shell (`renderShell: "default"`)
- Truncation info and nextOffset in details

### Write Tool
- **renderCall**: Shows path, line count, provenance (intent/rationale), content preview (truncated to 16 lines in compact mode)
- Delegates execution to built-in tool

### Undo Tool
- **renderCall**: Shows "revert last edit"
- **renderResult**: Shows colored reverse diff

## Validation and Safety

### Error Codes

| Code | Source | Condition |
|---|---|---|
| `[E_BAD_REF]` | `parseAnchorRef` | Malformed LINE#HH reference |
| `[E_RANGE_OOB]` | `applyHashlineEdits` / `anchorPublicLineRef` | Line number out of file bounds |
| `[E_STALE_ANCHOR]` | `applyHashlineEdits` | Hash mismatch at anchor line |
| `[E_INVALID_PATCH]` | `assertNoDisplayPrefixes` | lines contains rendered LINEc│prefix |
| `[E_EDIT_CONFLICT]` | `assertNoConflictingSpans` | Overlapping edit spans |
| `[E_BAD_RANGE]` | `applyHashlineEdits` | Start line > end line |
| `[E_TOO_MANY_EDITS]` | `enforceEditCountLimit` | > 3 edits in a single call |
| `[E_FULL_REF_REQUIRED]` | `anchorPublicLineRef` | Missing endpoint content |
| `[E_LINE_CONTENT_MISMATCH]` | `anchorPublicLineRef` | Content hint doesn't match file |
| `[E_ASYMMETRIC_SHIFT]` | `anchorBareLineNumberEdits` | Start/end relocate by different offsets |
| `[E_WOULD_EMPTY]` | `edit.ts execute` | Empty result on > 50 line file |
| `[E_WRITE_VERIFY]` | `edit.ts execute` | Post-write read-back mismatch |
| `[E_REPLACE_TEXT_MISSING]` | `applyReplaceTextEdits` | replace_text without oldText |
| `[E_REPLACE_TEXT_NOT_FOUND]` | `applyReplaceTextEdits` | oldText not found in file |
| `[E_REPLACE_TEXT_NOT_UNIQUE]` | `applyReplaceTextEdits` | oldText occurs multiple times |
| `[E_UNSUPPORTED_OP]` | `normalizeEditItems` | Unknown op value |
| `[E_NO_UNDO]` | `undo.ts execute` | No edit to undo / turn window expired |
| `[E_EMPTY_FILE]` | `resolveEditTarget` | File is empty |

### Warning Codes

| Code | Source | Condition |
|---|---|---|
| `[W_STALE_CONTEXT]` | `anchorPublicLineRef` | Checksum mismatch, but content still matches |
| `[W_HASH_RELOCATE]` | `anchorPublicLineRef` | Hash-index relocation applied |
| `[W_BYTE_RELOCATE]` | `tryByteRelocate` | Byte-level relocation applied (Layer 5) |
| `[W_DUPLICATE_TARGET]` | `applyHashlineEdits` | Multiple edits target same anchor |
| (boundary dup) | `applyHashlineEdits` | Replacement boundary duplicates neighbor |
| (bare hash prefix) | `warnBareHashPrefixLines` | lines content looks like copied checksum prefix |
| (suspicious unicode) | `maybeWarnSuspiciousUnicodeEscapePlaceholder` | `\\uDDDD` in edit content |

### Input Guards

1. **Hashline display prefix rejection** (`assertNoDisplayPrefixes`): Any line in the edit payload matching `LINEc│`, `>>>LINE#HH│`, `+LINEc│`, or `-LINE ` is rejected with `[E_INVALID_PATCH]`. The model must send literal file content.

2. **Bare hash prefix warning** (`warnBareHashPrefixLines`): A single-letter `c│` prefix is ambiguous (could be real file content). Warns if ≥ 2 such lines exist or if the letter matches a real file checksum — never silently strips.

3. **Unicode confusable hyphen normalization** (`normalizeConfusableHyphens`): Replaces Unicode dashes (U+2010–U+2015, U+2212, U+FE58, U+FE63, U+FF0D) with ASCII hyphen-minus before application.

4. **Non-UTF-8 detection**: U+FFFD detection in read output surfaces a warning that editing will rewrite as UTF-8.

## File Writing Safety

### `writeFileAtomically` (`src/fs-write.ts`)

```
writeFileAtomically(path, content)
  ├─ resolveMutationTargetPath(path) — symlink chain resolution
  │   └─ walks each path component, resolves symlinks as encountered
  │   └─ ELOOP detection (visited symlink set)
  ├─ stat(targetPath) — check if file exists
  ├─ if nlink > 1 → writeFile in-place (hard-linked files)
  └─ else:
      ├─ dir = dirname(targetPath)
      ├─ tempPath = join(dir, `.tmp-${randomUUID()}`)
      ├─ mkdir(dir, { recursive: true })
      ├─ writeFile(tempPath, content, { flag: "wx", mode })
      └─ rename(tempPath, targetPath) — atomic
```

### `resolveMutationTargetPath`

Resolves the canonical write path by walking each path component and following symlinks. This ensures that when two different symlinks point to the same real path, they share the mutation queue (see below).

### `withFileMutationQueue`

From `@earendil-works/pi-coding-agent` — serializes edits to the same canonical path. If the agent sends two edit calls for the same underlying file (via different symlink paths), they queue rather than race.

## Additional Design Details

### Diff Format (`src/edit-diff.ts`)

Uses `diff.structuredPatch` with 4 lines of context. Lines are prefixed with:
- ` ` (space) for context, with `LINEc│content` format
- `-` for removals, with `LINEc│content` format (computed from old file)
- `+` for additions, with `LINEc│content` format (computed from new file)

Hunks are separated by `    ...` (spaced ellipsis).

`buildCompactHashlineDiffPreview()` provides a collapsed preview with configurable maximum runs for unchanged (default 2), added (default 4), and removed (default 4) lines, capped at 12 output lines total.

### Metrics Tracking (`src/edit-response.ts`)

Every edit response includes metrics:
- `edits_attempted`: total edit entries in the tool call
- `edits_noop`: how many produced identical content
- `warnings`: count of advisory warnings issued
- `classification`: `"applied"` or `"noop"`
- `added_lines` / `removed_lines`: from diff count (applied only)

### Snapshot System (`src/snapshot.ts`)

`getFileSnapshot()` generates a fingerprint: `v1|<canonicalPath>|<mtimeMs>|<size>`. This is returned only in `details.snapshotId` for host UI use (e.g., "file changed since last view"). It is **not** surfaced to the LLM or used to reject edits.

### File Kind Detection (`src/file-kind.ts`)

Reads the first 8192 bytes for MIME detection via `file-type`:
- **Images**: JPEG, PNG, GIF, WebP → passed through as inline display
- **Null bytes**: any null byte in the full file → classified as binary
- **Non-UTF-8 text**: decoded with U+FFFD replacement (CP1251, GBK, etc. are readable)
- **Directory**: listed with first 50 entries
- **Other binary**: rejected with MIME type description

### Turn Tracking for Undo (`src/undo.ts`)

`turn_start` event increments `currentTurnIndex` (set via `setCurrentTurn`). The undo stack entry stores the turn index when the edit was made. On undo, if `currentTurnIndex - edit.turnIndex > MAX_UNDO_TURNS` (3), undo is denied. This prevents undoing edits from distant conversation history.

## Testing Architecture

- 225 tests across 29 files
- `test/core/`: tests for hashline primitives — parse, hash, resolve, apply, recovery, fuzzy relocate
- `test/tools/`: tests for tool behavior — edit (apply, preview, queue, render, noop-warning), read, write, undo, fs-write, file-kind, metrics
- `test/integration/`: end-to-end flows — chained multi-edit anchors, stale-position compound edits, strict hashline loop
- `test/extension/`: extension registration surface
- `test/support/fixtures.ts`: temp-file helpers for isolated test environments

## Environment Variables

| Variable | Effect |
|---|---|
| `PI_HASHLINE_DEBUG=1` | Shows "Hashline Edit mode active" notification on session start |

## Build-Time Dependencies

| Dependency | Purpose |
|---|---|
| `diff` | `structuredPatch` for diff generation |
| `file-type` | MIME sniffing from byte sample |
| `@sinclair/typebox` | Tool parameter schemas |
| `@earendil-works/pi-coding-agent` | Extension API, built-in tool delegates, file mutation queue |
| `@earendil-works/pi-tui` | `Text` component for TUI rendering |
| `@earendil-works/pi-ai` | Peer dependency |

## Provenance Chain

```
oh-my-pi (can1357, MIT)
  └─ RimuruW/pi-hashline-edit — multi-op schema, ZPMQVRWSNKTXJBYH hash alphabet
      └─ JerryAZR/pi-hashline-edit — single-op schema, hex hash, FNV-1a with neighbor context, │ separator, undo, 3-tier recovery
          └─ cgint/pi-line-edit — full endpoint refs (LINEc│content), write tool with provenance
              └─ @k0valik/pi-hashline-edit (this directory) — monorepo integration, read tool, async preview, 4-layer recovery
```

The upstream analysis documents (`upstream_docs/*.md`, `upstream_docs/*.py`, `profiling/`) are kept verbatim - they encode failure modes and design tradeoffs discovered by the upstream authors.

> **Stress-test findings:** See [`docs/byte-level-relocation-findings.md`](../docs/byte-level-relocation-findings.md) for failure modes discovered during systematic Layer 5 testing.
