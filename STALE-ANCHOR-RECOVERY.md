# Stale-Anchor Recovery: Options Analysis

This document catalogs the approaches for recovering from stale edit anchors — when a model issues an edit with line-number references that no longer match the current file content because a prior edit in the same session shifted the target.

**Scope:** All options below apply to the single-ref `anchorPublicLineRef` function in `src/edit.ts` unless otherwise noted. The analysis assumes consecutive edits to the same file in the same session.

---

## Background: The Failure Pattern

1. **Edit A** inserts/deletes N lines → file shifts by N lines
2. **Edit B** targets line numbers from *before* Edit A (stale in-memory state)
3. Extension validates content hint at the expected line → mismatch → hard error

All observed failures have N ≤ 11. The model reliably fails to re-read between consecutive edits to the same file.

---

## Option 0: Status Quo — Hard Error

**What it does:** When the content hint doesn't match at the expected line, throw `[E_LINE_CONTENT_MISMATCH]` instructing the model to re-read and retry.

**Failure modes addressed:** (none — it allows the model to fail forward)

**Failure modes introduced:**
- Model ignores the instruction and retries with the same stale refs (observed: 3+ retries before re-reading)
- Model retries with slightly different escaping of the same content hint (observed: escaped-quote mismatch)
- Model gives up and uses a full-file write instead of a targeted edit
- Wasted round-trips: error → re-read → retry (30+ seconds each in worst case)

**Tradeoffs:**
- Pro: Maximally safe — never silently relocates to wrong position
- Pro: Simple — ~5 lines of code
- Con: Highest model friction; the model consistently fails to follow the error instruction
- Con: The error message is confusing (`E_LINE_CONTENT_MISMATCH` reads as "your content is wrong" not "the file changed, re-read it")

**Suitability:** Better than silent corruption, but the model-side failure pattern (ignoring instructions, retrying stale refs) is consistent enough to warrant a softer fallback.

---

## Option A: ±N Fuzzy Relocation (recommended)

**What it does:** When the content hint doesn't match at the expected line, search ±N lines around the expected position for the exact content hint. If exactly one match is found, relocate the anchor to that position, emit a `[W_STALE_CONTEXT]` warning, and proceed. If zero or multiple matches, hard-error as in Option 0.

**How it integrates:** Modified inside `anchorPublicLineRef` at the existing content-mismatch check (`src/edit.ts`, line ~184). Each endpoint (start, end) is validated independently.

**Failure modes addressed:**
- Content shifted by up to N lines due to prior edit in the same session
- Content shifted asymmetrically (start and end at different offsets) — each endpoint is relocated independently, but the edit range still covers the intended content

**Failure modes introduced:**

1. **False positive within ±N:** A line with identical content exists at a different position within the search radius. Risk increases with:
   - Small files where lines like `}`, `);`, `const x = 1;` repeat
   - Highly repetitive content (data files, CSV, JSON arrays of objects)
   - Large N (bigger search window → more chances for collision)
   - **Mitigation:** Multi-match rejection (zero/multiple → hard error). For single-line edits, any match found within ±N is accepted; this is the riskiest case.

2. **Asymmetric relocation:** If start line content matches at +5 and end line content at +3 (because intervening content changed), the relocated range covers different content than intended. Example: edit targets `lines 10-12`, content shifts to `15-17` for the start but `15-16` for the end after a partial content edit. The resulting edit applies to a different slice of the file.
   - **Mitigation:** Check that both endpoints shifted by the same offset. If offsets differ, reject with hard error.
   - **Unmitigated risk:** If both endpoints happen to match at the same offset but the content between them changed (lines were inserted/deleted within the range), the edit still applies at the wrong position. This is less likely but possible.

3. **Complete-file rebuild false positive:** If the model rewrites the entire file (Edit A = full rewrite), then Edit B targets old line refs, the content might match at completely different positions because the rewrite preserved some lines. The fuzzy relocate could silently target the wrong region.
   - **Mitigation:** Track whether the last edit was a full-file write (the write tool could emit a reset event). If the file was fully rewritten between the read and the edit, skip fuzzy relocation entirely.

4. **Boundary straddle:** The expected line is near the file boundary and the search radius extends past the file (e.g., expected line 3, searching ±15 goes into negatives or past EOF). These out-of-bounds positions are skipped; the effective search radius is smaller near the edges.

**Effect of N:**
| N | Covers shift of | Max false-positive risk | Safe at EOF |
|---|---|---|---|
| 5 | 5 lines | Low | Line 6+ |
| 10 | 10 lines | Moderate | Line 11+ |
| 15 | 15 lines | Moderate+ | Line 16+ |
| 20 | 20 lines | High | Line 21+ |

All observed failures had shifts ≤ 11. N=15 is a safe default that covers all observed cases while keeping false-positive risk moderate.

**Safe-offset validation (mitigation for asymmetric relocation):**
```
expected line shift = relocated_line - expected_line
(expected_start_shift === expected_end_shift) ? proceed : reject
```
If both endpoints moved by the same offset, the range as a whole shifted but the content is consistent. If they moved by different offsets, the range has been stretched/shrunk — reject.

**Tradeoffs:**
- Pro: Handles the dominant failure pattern (small shift from prior edit)
- Pro: Degrades gracefully to hard error when uncertain (multi-match or asymmetric offset)
- Pro: ~30 LOC to implement; no new dependencies
- Con: Gives false confidence — model may learn to NOT re-read because the extension silently fixes it
- Con: Asymmetric relocation is hard to detect without checking both endpoints' offsets
- Con: Still fails for shifts > N (degrade to hard error; no regression from status quo)

**Suitability:** Best pragmatic balance. Handles the observed failure pattern without introducing new failure modes that are worse than the current hard error.

---

## Option B: Full-File Content Search

**What it does:** When the content hint doesn't match at the expected line, search the entire file for the exact content hint. If exactly one match, relocate. If zero or multiple, hard error.

**Failure modes addressed:**
- All the same as Option A but without the ±N bound — handles any shift size

**Failure modes introduced:**

1. **Same as Option A failure modes 1-4**, but amplified by the unbounded search radius. A duplicate line anywhere in the file causes a multi-match rejection (safe, but frustrating) or a false positive if the content only appears once but at a completely unrelated position (unsafe).

2. **Section cross-match:** The content hint is a distinctive line like `def process_data():` but the same function signature happens to appear in another section (e.g., a typed variant or an overload). The edit relocates to the wrong function in the wrong part of the file. The range content may still "look right" (same function body) but is semantically wrong.
   - **Mitigation:** None beyond the safe-offset check (Option A mitigation #2). If both endpoints match at the same offset, the edit proceeds silently.

3. **Deleted-then-recreated cross-match:** Content was deleted and recreated in a different part of the file with the same text (e.g., a config key moved from one section to another). The edit silently targets the new location — the range content matches but the edit was meant for the old location.

**Tradeoffs:**
- Pro: Handles any shift size (e.g., if the first edit added 50+ lines)
- Pro: ~25 LOC; simpler than Option A (no bounds checking)
- Con: Significantly higher false-positive risk for common-content lines
- Con: Cross-section relocation is hard to detect and potentially destructive
- Con: Unbounded search creates a "magic fix" impression that trains the model to never re-read

**Suitability:** Too risky for general use. Only safe for highly-distinctive single-line edits (e.g., a unique heading or a rare variable name). The failure modes are worse than the status quo.

---

## Option C: Jerry's 3-Tier (Exact → Fuzzy ±Range → 3-Way Merge)

Reference implementation: `tmp/hashline-edit-repos/pi-hashline-edit-jerry/src/{fuzzy-match.ts, merge.ts, read-snapshot.ts}`

**What it does:** Three escalation tiers:
1. **Tier 1 (Exact):** Match edit anchors against current file hashes. Pass through.
2. **Tier 2 (Fuzzy ±N):** For unmatched anchors, search the current file for the *full range content* (not just the content hint of one line). Both endpoints shift together. ±1 for single-line edits, ±2 for multi-line.
3. **Tier 3 (3-Way Merge):** Apply the stale edits against the last-read snapshot, compute a diff patch, and apply that patch against the current file (`diff.applyPatch` with `fuzzFactor: 0`).

**Key difference from Option A:** Tier 2 matches the *entire range content* (all lines between start and end), not just the content hint of one endpoint. This dramatically reduces false positives.

**Failure modes addressed:**
- Matches content that shifted by ≤ ±2 lines (Tier 2)
- Matches content that changed externally between read and edit (Tier 3 — snapshot → patch replay)

**Failure modes introduced:**

1. **Tier 2 radius too small:** ±2 doesn't cover the dominant failure pattern (shifts of 3-11 lines). The implementation falls through to Tier 3 instead of recovering at Tier 2.
   - **Mitigation:** Increase the ±N search radius as in Option A.

2. **Tier 3 merge corruptions:** `diff.applyPatch` with `fuzzFactor: 0` means the patch must apply exactly to the current file. If the current file has unrelated changes in the same region, the merge returns `null` (safe). If the patch applies cleanly but at the wrong context (because the file changed structurally), the merge produces incorrect output.
   - **Mitigation:** None with `fuzzFactor: 0`. A higher fuzzFactor tolerates more misalignment but increases corruption risk.
   - **Observed issue:** Jerry's implementation uses `fuzzFactor: 0` explicitly to reject misaligned hunks. This means Tier 3 effectively never recovers from anything beyond a trivial shift.

3. **Snapshot staleness:** The snapshot is captured at read time. If the file was modified outside of pi (e.g., by the user, or by the extension's own write tool), the snapshot doesn't reflect the current file state. Tier 3 would compute a patch against the wrong base.
   - **Mitigation:** The write tool and edit tool both clear or update the snapshot after a successful mutation.

4. **Silent relocation in Tier 2:** The `[RELOCATED]` warning is easy to miss in a TUI card with lots of diff content. The model (and user) may not notice that anchors were relocated, and the resulting edit is applied somewhere the model didn't intend.

**Tradeoffs:**
- Pro: Tier 2 is safer than Option A (matches entire range, not just one line's content hint)
- Pro: Three-tier escalation is elegant; exact for clean cases, fuzzy for small shifts, merge for external changes
- Pro: Proven in production (Jerry's fork, multiple releases)
- Con: Tier 2 radius is too small — needs to be increased to match the observed failure pattern
- Con: Tier 3 is essentially dead code with `fuzzFactor: 0` — never recovers from anything beyond a ±2 shift
- Con: Requires snapshot infrastructure (already present in our baseline) and 3-way merge code (~150 LOC total across 2 files)
- Con: More complex than Option A — three tiers with different failure modes each

**Suitability:** Over-engineered for the observed failure pattern. The Tier 2 radius fix (increase to ±N) makes it Option A with extra complexity. The 3-way merge tier is not useful with `fuzzFactor: 0` and dangerous without it.

---

## Option D: Auto-Re-Read Between Consecutive Edits

**What it does:** When an edit targets the same file as the previous successful edit, automatically re-read the file from disk and re-anchor the refs before validation. This treats the in-memory state as stale by default for consecutive edits.

**How it integrates:** Track the last-edited file path in `src/undo.ts` (already has `setLastEdit`/`getLastEdit`). When `anchorPublicLineRef` is called and the file was just edited, silently re-fetch the file content and use the fresh content for validation.

**Failure modes addressed:**
- Root cause: stale in-memory state from a prior edit in the same session
- All shift sizes (the re-read captures the exact current state)

**Failure modes introduced:**

1. **File modified externally between edit and re-read:** If another tool (or the user) modifies the file between the auto-re-read and the validation, the auto-refreshed content is also stale. This is unlikely in practice (the edit tool is synchronous within one tool call) but possible in parallel scenarios.
   - **Mitigation:** None beyond the normal content-validation check. If the content changed between auto-re-read and validation, the content hint check catches it.

2. **Performance:**
   - Auto-re-reading adds a synchronous disk I/O per consecutive edit. For most files (<1MB), this is negligible (~1ms). For very large files (>10MB), this could add latency.
   - **Mitigation:** Only auto-re-read when `getLastEdit().path === current_path`. This is a fast in-memory check followed by a single readFileSync.

3. **Read permission change between edits:** If the file's permissions changed between the first and second edit (e.g., the model ran `chmod` as part of the first edit), the auto-re-read could fail with EACCES.
   - **Mitigation:** Catch EACCES, fall through to the content-hint validation against the old in-memory content. If that fails, hard-error (status quo).

4. **Hidden file corruption:** The file is re-read from disk, which works fine. No corruption risk here.

**Tradeoffs:**
- Pro: Handles the root cause — the model's in-memory state being stale
- Pro: No false-positive risk (reads the exact current file content — the ground truth)
- Pro: Very simple — ~15 LOC in `anchorPublicLineRef`
- Pro: Works for any shift size
- Pro: Does not train the model to skip re-reading (the model doesn't know the extension did this)
- Con: Only helps for consecutive edits to the same file. If the model reads a different file and then comes back, the stale state persists.
- Con: Only helps when the file hasn't been modified externally between edits (common case, but not guaranteed)
- Con: Adds a synchronous readFileSync per consecutive edit (negligible for typical files)

**Suitability:** Cleanest approach for the pattern we actually observe. Handles the root cause rather than the symptom. Combined with Option A's ±N fuzzy relocate as a fallback (when auto-re-read also fails), this covers essentially all failure modes without silent corruption risk.

---

## Option E: Combined — Auto-Re-Read + ±N Fallback

**What it does:** Two-layer defense:
1. **Auto-re-read** (Option D): When consecutive edits target the same file, refresh content from disk. If the refreshed content resolves the anchor, proceed.
2. **±N fuzzy relocate** (Option A): If the auto-re-read still doesn't match (because the content changed structurally, not just shifted), try ±N fuzzy relocation.
3. If both fail, hard error (status quo).

**Failure modes addressed:**
- Consecutive-edit stale state → auto-re-read handles it (no false positives)
- Content changed structurally between reads → fuzzy relocate handles small shifts
- Both fail → hard error (no regression)

**Failure modes introduced:**
- Combined complexity of Option A + Option D
- Only helps in the consecutive-edit case (same file as last edit)
- Still fails for non-consecutive edits (different file → back, or edit → write → edit)

**Tradeoffs:**
- Pro: Auto-re-read catches the common case cleanly; fuzzy relocate is the safety net
- Pro: Both degrade to hard error when uncertain
- Pro: ~45 LOC total
- Con: Slightly more complex than either option alone
- Con: The "same file" check means non-consecutive edits to the same file (read another file in between) still get the status quo behavior

**Suitability:** Most robust option if implementation complexity is acceptable. The two layers cover distinct failure modes with minimal overlap.

---

## Recommendation

**Option E (Auto-Re-Read + ±N Fuzzy Fallback)** is the best choice if implementation cost is acceptable. It handles the root cause (stale state) cleanly and has a safety net for structural changes. ~45 LOC.

**Option D (Auto-Re-Read Only)** is the best choice if simplicity is preferred. It handles all observed failure cases without false-positive risk. ~15 LOC.

**Option A (±N Fuzzy Relocation Only)** is the best choice if the consecutive-edit check feels too narrow. ~30 LOC, handles all shift sizes ≤N, but has asymmetric-relocation risk.

The status quo (Option 0) is acceptable only if the model's instruction-following improves. Current evidence suggests it won't.
