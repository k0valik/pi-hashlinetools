# pi-hashline-edit — Remaining Improvements

> Compiles all findings from `docs/edit-failure-cascades.md` and `docs/byte-level-relocation-findings.md` that are **still unfixed / unimplemented** as of the current codebase state.
>
> Items are ordered by leverage (impact ÷ effort). Each item is self-contained and implementable independently.

---

## Table of Contents

1. [A — Unified Anchor Format (post-edit anchors match `read` format)](#a--unified-anchor-format)
2. [B — Improved `undo` Tool Description](#b--improved-undo-tool-description)
3. [C — Common Mistakes Section in `edit.md`](#c--common-mistakes-section-in-editmd)
4. [D — Post-Edit Anchor "What Changed" Highlight](#d--post-edit-anchor-what-changed-highlight)
5. [E — Consecutive-Edit Auto-Re-Read + Intent Heuristic](#e--consecutive-edit-auto-re-read--intent-heuristic)
6. [F — Bare `\r` Line-Counting Mismatch in `tryByteRelocate`](#f--bare-r-line-counting-mismatch-in-trybyterelocate)
7. [G — Layer 4 Silent Failure Diagnostic](#g--layer-4-silent-failure-diagnostic)

---

## A — Unified Anchor Format

**Source:** `docs/edit-failure-cascades.md §4.1`
**Status:** ❌ Not implemented
**Effort:** ~10 LOC + test updates

### Problem

The model sees two different anchor formats:

| Source | Format | Example |
|--------|--------|---------|
| `read` tool output | `NNc│content` (public checksum letter) | `250e│[yonilerner]` |
| `edit` post-edit anchors | `NN#HH│content` (raw FNV-1a hash) | `250#6C│[yonilerner]` |

This format switching adds cognitive load and increases the chance the model picks the wrong line number on consecutive edits.

### Change

In `src/edit.ts` — `buildPostEditAnchors` (line ~264), emit using `formatPublicLineRef` instead of the raw FNV-1a hash.

**Current code:**
```ts
const hash = computeLineHash(lines, i - 1);
refs.push(`  ${i}${ANCHOR_SEP}${hash}${CONTENT_SEP}${lineContent}`);
```

**Proposed code:**
```ts
refs.push(`  ${formatPublicLineRef(lines, i)}${CONTENT_SEP}${lineContent}`);
```

### Preconditions

- `formatPublicLineRef` already exists in `src/line-ref.ts:21-23`.
- It is **not** currently imported in `src/edit.ts`. Add to the import block at line ~29-33.

### Why 2-char hex, not a single letter

The `publicChecksumFromHash` function (`line-ref.ts:11-15`) artificially reduces the 256-value hex hash to 26 letters via `% 26`. This is unnecessary - `computeLineHash` already returns a 2-char hex string (256 values) via `DICT[hash & 0xff]` at `hashline.ts:80`. The fix is to use the 2-char hex directly as the public checksum, keeping collision rates at ~1/256. Display format becomes `2506c│content` (one extra char per line vs `250e│content`).

**Changes required:**

1. **`line-ref.ts`**: Modify `publicChecksumFromHash` to return the first 2 hex chars directly. Remove `% 26` and `CHECKSUM_ALPHABET`.
2. **`line-ref.ts`**: Update `parsePublicLineRef` regex from `^([a-z])` to `^([0-9a-f]{2})`.
3. **`tool-descriptions/edit.md`**: Update example format from `42f│` to `426c│`.
4. **Tests**: Update all assertions on the single-letter format.

The hashline hash can still be carried internally for collision-resistant index lookups; only the **display** format changes.

### Files to touch

| File | Change |
|------|--------|
| `src/line-ref.ts` | Modify `publicChecksumFromHash` to return 2-char hex; update `parsePublicLineRef` regex |
| `src/edit.ts` | Import `formatPublicLineRef`; change `buildPostEditAnchors` line ~264 |
| `tool-descriptions/edit.md:37` | Update "Post-edit anchors" section to describe the unified format |
| `test/` | Update tests asserting single-letter checksum format |

---

## B — Improved `undo` Tool Description

**Source:** `docs/edit-failure-cascades.md §4.3`
**Status:** ❌ Not implemented
**Effort:** docs only (~15 lines added)

### Problem

The current `tool-descriptions/undo.md` (7 lines) frames undo as recovery from "corruption" — a strong word. The model in the observed cascade didn't think the file was corrupted; it thought it made a small mistake and could patch it. So it never reached for `undo`.

### Change

Replace `tool-descriptions/undo.md` with an expanded version that:

1. Lowers the threshold: "did not do what you intended" instead of "corrupted a file"
2. Lists common triggers (wrong range, wrong op, unexpected diff, mid-edit realization)
3. Adds robustness guarantees (byte-for-byte restore, works after consecutive edits, clears `lastEdit`)
4. Notes limitations (only most recent edit, 3-turn window, does not undo `write`)

#### Proposed content

```md
Undo the most recent hashline edit. No parameters.

Use this when an `edit` call did not do what you intended and you want to revert immediately, instead of writing a corrective `edit` call. Common triggers:
- You replaced a line you did not mean to replace (wrong range).
- You used `replace` when you should have used `append`/`prepend`.
- The result diff shows changes you did not expect.
- You realized mid-edit that the operation was wrong.

Robustness:
- Undo restores the file to the exact pre-edit state (byte-for-byte, preserving trailing newlines and BOM).
- It works even if you issued multiple consecutive edits — only the most recent is reverted.
- After undo, the `lastEdit` slot is cleared, so you cannot undo twice in a row.
- Post-edit anchor refs from before the undone edit are still valid (the file is back to that state).

Limitations:
- Only the most recent edit can be undone. A second `undo` will fail.
- Undo is only available within 3 turns of the edit. After that, use `read` and `edit` to fix the file.
- Undo does not undo `write` operations.
```

### Files to touch

| File | Change |
|------|--------|
| `tool-descriptions/undo.md` | Replace content with the proposed text above |

---

## C — Common Mistakes Section in `edit.md`

**Source:** `docs/edit-failure-cascades.md §4.5`
**Status:** ❌ Not implemented
**Effort:** docs only (~10 lines added)

### Problem

The edit tool description has no guidance about the most common failure pattern: using `replace` when the model meant `insert`, choosing the wrong line after a prior edit, and cascading corrective edits instead of using `undo`.

### Change

Append a "Common mistakes to avoid" section to `tool-descriptions/edit.md` after the existing "Post-edit anchors" section (line ~36).

#### Proposed content

```md
### Common mistakes to avoid

- **Replacing a line when you meant to insert.** If you want to add a new row between two existing lines, use `op: "append"` with the line above, or `op: "prepend"` with the line below. Do not use `range: [x, x]` with extra lines in `lines` unless you specifically want to overwrite that line.
- **Wrong line after a prior edit.** The post-edit anchor block shows the current state of the changed region. If the post-edit block does not include the line you want to edit, re-read the file with the `read` tool before editing.
- **Cascading corrections.** If you realize an edit was wrong, use `undo` (reverts the most recent edit in one call) rather than issuing a corrective `edit`. Three `undo`less corrections to fix one mistake is a sign the original intent was lost.
```

### Files to touch

| File | Change |
|------|--------|
| `tool-descriptions/edit.md` | Append "Common mistakes to avoid" section after line ~36 |

---

## D — Post-Edit Anchor "What Changed" Highlight

**Source:** `docs/edit-failure-cascades.md §4.4`
**Status:** ❌ Not implemented
**Effort:** ~10 LOC

### Problem

After a successful edit, the post-edit anchor block shows the current state of the changed region but doesn't surface *what changed* (how many lines were replaced, how many inserted). The model has to reconstruct this from the diff, which is easy to overlook.

### Change

In `src/edit.ts` — `buildPostEditAnchors` (line ~247), accept the original vs result content so you can compare line counts for the affected range. When `firstChangedLine !== lastChangedLine` AND the edit had a `range` that covered N original lines but produced M replacement lines with M > N, append a summary line after the header.

#### Signature change

```ts
function buildPostEditAnchors(
  content: string,
  firstChangedLine: number | undefined,
  lastChangedLine: number | undefined,
  originalLineCount?: number,       // NEW: range length before edit
  replacementLineCount?: number,    // NEW: lines.length after edit
): string | undefined
```

#### Summary line format

```
[Region 252-253: 2 lines replaced with 3 (insert of 1 line). To undo, use `undo` or re-edit the range.]
```

Only emit when `replacementLineCount !== originalLineCount` (something structurally changed). For equal counts (pure replacements), no summary needed.

### Call site

The call site at `src/edit.ts:1307-1311` needs to pass the extra info. The `anchorResult` from `resolveEditAnchors` doesn't currently expose original counts — you may need to compute them from the raw edits before resolution.

### Files to touch

| File | Change |
|------|--------|
| `src/edit.ts` | Extend `buildPostEditAnchors` signature and logic; update call site (~1307) |
| `src/edit.ts` | Possibly extend `anchorResult` to carry original range counts |

---

## E — Consecutive-Edit Auto-Re-Read + Intent Heuristic

**Source:** `docs/edit-failure-cascades.md §4.2`
**Status:** ❌ Not implemented
**Effort:** ~30 LOC + test

### Problem

When the model issues a second consecutive edit to the same file, the in-memory state may be stale even though the anchor refs happen to be technically correct (the "stale-but-coincidentally-correct" trap). Additionally, the model sometimes uses a single-line `range: [x, x]` with multiple `lines` to simulate an insert, which is a signal of confused intent.

### Foundation

The `lastEdit` state already exists in `src/undo.ts` (lines ~40-57, `getLastEdit`/`setLastEdit`) and is set on every successful edit (`src/edit.ts:1275`). It is **never consumed** for this purpose.

### Change — two parts

#### Part 1: Auto-re-read on consecutive edit

In `src/edit.ts` execute path, **before** `anchorBareLineNumberEdits` is called:

```ts
const lastEdit = getLastEdit();
if (lastEdit?.path === path) {
  // Option D: re-read the file from disk to ensure freshness
  const freshContent = await readFile(absolutePath, 'utf8');
  // Re-derive fileLines, visibleLineCount, rawBuffer from freshContent
  // and use those for anchor resolution instead of the stale in-memory content
}
```

This is a cheap (~1ms for most files) defensive measure.

> **Design note:** The re-read must use `readFile` (async) to match the existing pattern, but the anchor resolution layers are synchronous. A synchronous `readFileSync` (already imported on line 8) is acceptable here since it's a single small fie read on the hot path.

#### Part 2: Insert-as-replace heuristic

After the auto-re-read, check each edit item:

```ts
for (const edit of toolEdits) {
  if (edit.op === 'replace' && edit.range && edit.lines) {
    const [startRef, endRef] = edit.range;
    const parsed = parsePublicLineRef(startRef);
    if (parsed && parsed.line === parsePublicLineRef(endRef)?.line) {
      // Single-line range
      if (edit.lines.length > 1) {
        warnings.push(
          `[W_POSSIBLE_INSERT_AS_REPLACE] range [${parsed.line}, ${parsed.line}] has ${edit.lines.length} replacement lines but only 1 source line. This looks like an insert. Use op: "append" or "prepend" instead of "replace" when adding new rows.`,
        );
      }
    }
  }
}
```

### Files to touch

| File | Change |
|------|--------|
| `src/edit.ts` | Hook into execute path before `anchorBareLineNumberEdits`; add heuristic loop |
| `src/edit.ts` | Import `getLastEdit` from `./undo` (already imported: `setLastEdit` on line 37) |
| `test/` | Add test for consecutive-edit re-read + heuristic warning |
| `tool-descriptions/edit.md` | Document `W_POSSIBLE_INSERT_AS_REPLACE` warning (optional) |

---

## F — Bare `\r` Line-Counting Mismatch in `tryByteRelocate`

**Source:** `docs/byte-level-relocation-findings.md §F3`
**Status:** ❌ Still present in code
**Effort:** ~8–15 LOC (2 options)

### Problem

`tryByteRelocate()` (line ~321-326) maps byte position to 1-based line number by counting `0x0a` bytes only:

```ts
let lineNum = 1;
for (let i = 0; i < positions[0]!; i++) {
  if (rawBuffer[i] === 0x0a) lineNum++;
}
```

But `visibleLineCount` (from the normalized text) treats bare `\r` as a line break (`normalizeToLF` converts bare `\r` to `\n`). So if a file contains bare `\r` characters (rare but possible from bad Windows-to-Unix conversions):

- Normalized text: `"a\nb\nc\nd"` → 4 visible lines
- Raw buffer `\n` count: 2 (`b\n` and after `\r\n`)
- `tryByteRelocate` maps content on line 4 to **line 3** (off by one)
- The bounds check `lineNum <= visibleLineCount` passes (3 ≤ 4), so the **wrong line number is silently returned**

### Fix — Option A: Normalize CR in line counting (robust)

Count `\n` using the same normalization as `visibleLineCount`:

```ts
let lineNum = 1;
for (let i = 0; i < positions[0]!; i++) {
  // CRLF → one line
  if (rawBuffer[i] === 0x0d && rawBuffer[i + 1] === 0x0a) {
    lineNum++;
    i += 1; // skip the \n we already consumed
    continue;
  }
  // LF or bare CR → one line
  if (rawBuffer[i] === 0x0a || rawBuffer[i] === 0x0d) {
    lineNum++;
  }
}
```

### Fix — Option B: Reject on count mismatch (simple)

If the raw buffer's `\n` count doesn't match `visibleLineCount`, refuse to guess:

```ts
let rawNewlines = 0;
for (let i = 0; i < rawBuffer.length; i++) {
  if (rawBuffer[i] === 0x0a) rawNewlines++;
}
const rawLines = rawBuffer[rawBuffer.length - 1] === 0x0a ? rawNewlines : rawNewlines + 1;
if (rawLines !== visibleLineCount) return null; // Refuse to guess
```

### Recommendation

Option A is preferred — it's more robust and doesn't drop coverage on edge cases. Option B is simpler but may cause more false rejections.

### Files to touch

| File | Change |
|------|--------|
| `src/edit.ts` | `tryByteRelocate` line-counting loop (~lines 322-326) |

---

## G — Layer 4 Silent Failure Diagnostic

**Source:** `docs/byte-level-relocation-findings.md §F5`
**Status:** ❌ Still present
**Effort:** ~3 LOC

### Problem

Layer 4 (hash-index relocation by stale public checksum) falls through silently when every checksum letter in a file has ≥2 matching lines. The fallback error at line ~465 doesn't mention Layer 4 at all:

```
[E_LINE_CONTENT_MISMATCH] ... Content not found (0 matches) or ambiguous (2+ matches) within ±40 lines.
```

When the true reason for failure is "checksum letter 'x' matches 6 lines, refusing to guess", the diagnostic is misleading.

### Change

In `anchorPublicLineRef`, when falling through from Layer 4 to the hard error, capture the reason Layer 4 failed (checksum letter + match count) and append it to the error message.

**Current error (line ~465):**
```ts
throw new Error(
  `[E_LINE_CONTENT_MISMATCH] ... Content not found (0 matches) or ambiguous (2+ matches) within ±${FUZZY_SEARCH_RADIUS} lines. Re-read this region and retry with a unique full endpoint line.`,
);
```

**Proposed (append Layer 4 diagnostic):**
```ts
throw new Error(
  `${layer4Diagnostic ?? ""}[E_LINE_CONTENT_MISMATCH] ... Content not found (0 matches) or ambiguous (2+ matches) within ±${FUZZY_SEARCH_RADIUS} lines. Re-read this region and retry with a unique full endpoint line.`,
);
```

Where `layer4Diagnostic` is set during Layer 4's fallthrough pass:

```ts
let layer4Diagnostic = "";
// In Layer 4 (line ~403-429):
if (matchingLines.length > 1) {
  layer4Diagnostic = `Layer 4 (hash-index) checksum "${checksum}" found on ${matchingLines.length} lines, refusing to guess. `;
}
```

### Files to touch

| File | Change |
|------|--------|
| `src/edit.ts` | `anchorPublicLineRef` — capture Layer 4 reason, append to fallback error |

---

## Implementation Order (Recommended)

| Priority | Item | Effort | Leverage | Why this order |
|----------|------|--------|----------|----------------|
| **1** | B — Improved `undo.md` | docs only | High | Zero code risk; makes `undo` the obvious first-recourse |
| **2** | C — Common mistakes in `edit.md` | docs only | Medium | Zero code risk; educates the model before failure |
| **3** | A — Unified anchor format | ~5 LOC | High | Smallest code change with highest impact on cognitive load |
| **4** | D — "What changed" highlight | ~10 LOC | Medium | Requires A as a prerequisite if format changes |
| **5** | F — Bare `\r` fix | ~8-15 LOC | Low | Quick fix for a latent bug before it surfaces |
| **6** | E — Consecutive-edit heuristic | ~30 LOC | Medium | Most complex; benefits from A+B+C being in place first |
| **7** | G — Layer 4 diagnostic | ~3 LOC | Low | Quick quality-of-life improvement; independent of others |

Items 1–3 can be done in any order and don't conflict. Items 4–6 may touch overlapping code in `buildPostEditAnchors` and the execute path. Item 7 is completely independent.
