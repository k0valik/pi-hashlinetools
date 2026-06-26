# Monorepo Integration Plan

This document tracks the synthesis work for `@k0valik/pi-hashline-edit`: which fixes to lift from the JerryAZR and RimuruW forks that cgint's `pi-line-edit` did **not** carry forward, and the order in which to apply them.

This is a working document, not a release artifact. It is intended to be referenced in future sessions where the context is fresh and the diffing work needs to be redone from scratch.

---

## Status

- **0.1.0 shipped** (2025-06-15): clean monorepo port of cgint/pi-line-edit at `d003425`. See `CHANGELOG.md`.
- **0.2.0 (planned)**: synthesis of RimuruW and Jerry fixes not present in cgint.

---

## Starting state

The ported package in this directory is cgint/pi-line-edit at `d003425 fix(edit): require full endpoint refs`. cgint's history diverges from JerryAZR's at `100cb77 chore(release): v0.8.3`, and the divergence is the **line-endpoint-ref pivot** (`dddd4f9 Adapt extension for line-number editing` and 11 subsequent commits).

Three categories of "missing" work need consideration:

1. **Jerry's commits after cgint's branch point** — features cgint never picked up. ~5 commits.
2. **RimuruW's commits after Jerry's branch point** — fixes to the original hashline mechanic that never propagated through either fork. ~10 commits.
3. **RimuruW's commits after cgint's branch point but pre-dating Jerry's** — the bulk of the original work, mostly already absorbed by Jerry and inherited by cgint.

---

## Jerry's commits not in cgint

Listed in the order they should be considered for lifting. Jerry's master at HEAD is `e0f1210`; cgint's HEAD is `d003425`; the branch point in cgint is `100cb77`.

| Jerry commit | Title | Decision | Why |
|---|---|---|---|
| `af3735c` | revert(edit): monolithic diff line coloring; remove choppy anchor-dimming | **SKIP** | cgint already has the reverted form (cgint never picked up v0.8.1's dimming). No-op. |
| `302b412` | chore: add .tmp/ to .gitignore | **SKIP** | Pure repo hygiene; not relevant in a vendored context. |
| `b548867` | chore(release): v0.9.0 | **SKIP** | Release tag only. |
| `a8069f4` | chore(release): v0.10.0 | **SKIP** | Release tag only. |
| `e0f1210` | chore(release): v0.10.1 | **SKIP** | Release tag only. |

The substantive Jerry work after cgint's branch point is concentrated in the **v0.10.0** and **v0.10.1** release-tag parent commits:

- **v0.10.0 (`a8069f4`'s parent)** introduces **fuzzy anchor relocation** (3-tier stale-anchor recovery: exact → fuzzy ±1/±2 → 3-way merge with snapshot).
- **v0.10.1 (`e0f1210`'s parent)** introduces **compact/expanded diff in the result card** (16-line truncation in compact mode, full in expanded) and the **change summary line** ("22 insertions(+), 1 deletion(-)").

### What to lift from v0.10.1 (small, high value)

These are pure UX wins in the edit result render. They're ~30 LOC each in cgint's `edit.ts`. **LIFT BOTH.**

1. **Compact/expanded diff truncation** — Jerry's `formatResultDiff` truncates to 16 lines in compact mode and shows the full diff in expanded. cgint's `formatResultDiff` shows the full diff always (regression from Jerry's later re-org).
   - File to modify: `src/edit.ts`, function `formatResultDiff` and the call sites in `renderResult`.
   - Reference: `tmp/hashline-edit-repos/pi-hashline-edit-jerry/src/edit.ts` v0.10.1 logic. Diff against cgint's current implementation to identify the exact `expanded` parameter wiring.
   - Test: add a new test in `test/tools/edit.render.test.ts` (new file) that calls the render path with `expanded: true` and `expanded: false` and asserts line counts.

2. **Change summary line** — Jerry's `buildAppliedChangedResultText` adds a `"X insertions(+), Y deletion(-)"` line between the diff and the warnings, formatted with `theme.fg("accent", ...)`.
   - File to modify: `src/edit.ts`, function `buildAppliedChangedResultText` (cgint's existing function, near line 370).
   - Reference: `tmp/hashline-edit-repos/pi-hashline-edit-jerry/src/edit.ts` v0.10.1 logic.
   - Test: extend `test/tools/metrics.test.ts` (already covers added_lines/removed_lines) with a render test that asserts the summary line appears in the rendered output.

### What to lift from v0.10.0 (subsumed, do not lift)

Jerry's v0.10.0 introduces the **3-tier stale-anchor recovery**:
- Tier 1: exact hash match on current file.
- Tier 2: fuzzy content match ±1/±2 lines.
- Tier 3: 3-way merge using the most-recent-read snapshot.

**DO NOT LIFT** — cgint's design deliberately subsumes this:
- Tier 1 (exact) is the default cgint behavior.
- Tier 2 (fuzzy) is a workaround for the "anchor drifted but content unchanged" case. cgint handles this via stale-context warning + content validation: if the embedded content in the ref matches, proceed; if not, reject. This is more conservative than Jerry's fuzzy relocation (which silently relocates by ±1/±2 lines) and avoids the "close enough" failure mode that cgint's `CONSISTENCY-REVIEW.md` criticizes.
- Tier 3 (3-way merge) is a workaround for the "the file changed between read and edit" case. cgint's approach is to fail the edit and require a fresh `read`. This trades convenience for correctness.

Files associated with v0.10.0 that should NOT be lifted: `src/fuzzy-match.ts`, `src/merge.ts`, `src/read-snapshot.ts`. They implement the tiers we are deliberately not adopting.

---

## RimuruW's commits not in either fork

The "mainline" RimuruW has commits after the Jerry branch point (`ed46930 feat(atomic-write): set temp file mode on creation, eliminate chmod race`) that both forks absorbed, but also has commits the forks **did not** absorb that may still be relevant.

The substantive RimuruW-only fixes (i.e., neither Jerry nor cgint has them) are:

| RimuruW commit | Title | Decision | Why |
|---|---|---|---|
| `2f753f0` | fix(hashline): warn on bare hash prefixes (#25) | **LIFT** | Bare `HH:` form in `lines` (e.g., `KK:### heading`) is ambiguous; a single such line could be legitimate YAML. The warning is the right safety net. Adapting to cgint's `│` separator means changing the regex from `:` to `│`. |
| `43cf111` | fix(file-kind): read non-UTF-8 text files instead of rejecting them (#21) | **SKIP** | Both forks already absorb this via Jerry's v0.7.4. The U+FFFD warning is in cgint's `read.ts` already. |
| `19f974a` | fix(hashline): align rendered line numbers | **SKIP** | Already absorbed by Jerry's `formatHashlineRegion`. Inherited by cgint. |
| `ed46930` | feat(atomic-write): set temp file mode on creation, eliminate chmod race | **SKIP** | Both forks already absorb this. cgint's `fs-write.ts` writes with the existing file's mode. |
| `e7a1edd` | fix(edit): converge model dialects via a normalization layer | **SKIP** | cgint deliberately removed the `replace_text` op. Lifting this would re-introduce the "attractive nuisance" failure mode documented in Jerry's `ISSUE-silent-edit-failures.md`. |
| `b358f39` | chore: remove AGENTS.md and CLAUDE.md from version control | **N/A** | Repo hygiene; not relevant. |
| `7ed3df2` | fix(hashline): add edit safety guards | **PARTIAL** | cgint already has the single-anchor-multi-line warning and the symmetric boundary-duplication check. The remaining parts (Fuzzy Unicode quote normalization for `textHint` — but cgint doesn't use `textHint`) are subsumed. |
| `294a75b` | refactor(edit-response, hashline): apply test-quality audit fixes | **N/A** | Refactor only. |
| `b3bc5f3` | fix(edit): surface warnings in noop responses and harden validation | **SKIP** | cgint's `buildNoopResponse` already surfaces warnings. |
| `0bdf453` | refactor(edit-diff, hashline, file-kind, edit-response): delete dead surface | **N/A** | Refactor only. |
| `f125e2d` | feat(prompts, edit): raise prompt density and wire edit guidelines | **DEFER** | RimuruW's prompts are denser than cgint's minimal surface. Could be a separate "improve prompts" pass. Not a fix per se. |
| `a0ea9c1` | refactor(edit, edit-response, edit-render): delete returnMode/returnRanges payload modes | **SKIP** | Refactor only. cgint already has the trimmed schema. |
| `241108a` | test, refactor(edit-response, hashline): apply test-quality audit fixes | **N/A** | Test refactor. |
| `5782b1b` | fix(edit, hashline): restore lines type validation and execute() guard | **SKIP** | cgint has stricter `lines` validation already. |
| `7db527b` | refactor(edit): deepen module architecture across edit pipeline | **DEFER** | Could be a "tidy up" pass. Not urgent. |
| `30d47ce` | fix(edit): harden normalization and writes | **SKIP** | Both forks absorb. |
| `e7a1edd` | (already listed) | | |

### What to lift from RimuruW: 1 substantive change

1. **Bare hash prefix warning** — `HASHLINE_BARE_PREFIX_RE` + `warnBareHashPrefixLines` in `src/hashline.ts`.
   - **Reference:** `tmp/hashline-edit-repos/pi-hashline-edit/src/hashline.ts`, search for `HASHLINE_BARE_PREFIX_RE` and `warnBareHashPrefixLines`. Original alphabet `ZPMQVRWSNKTXJBYH` and separator `:`; **adapt to cgint's alphabet** (still 2 hex chars before the `│` separator, but the regex should match `0-9A-F{2}│`).
   - **Where it goes:** cgint's `src/hashline.ts`, after the noop detection phase, before `applyHashlineEdits` finalizes the result. The function signature is `warnBareHashPrefixLines(edits: HashlineEdit[], fileLines: string[], warnings: string[])`.
   - **Test:** add `test/core/hashline.bare-hash-prefix.test.ts` (new file). Cases:
     - `lines: ["KK:### heading"]` where `KK` is a real hash in the file → warning emitted.
     - `lines: ["TS:key"]` where `TS` is a real hash in the file → warning emitted.
     - `lines: ["XY:foo"]` where `XY` is NOT a real hash → no warning.
     - `lines: ["8#A4│content"]` → still rejected by `assertNoDisplayPrefixes` (covered by existing tests).
   - **Estimated work:** ~25 LOC + ~80 LOC of tests.

### What to consider but probably defer

- **Fuzzy Unicode quote/dash/space normalization for content hints** — RimuruW has it for `textHint` matching; cgint doesn't use `textHint` (it uses full endpoint content). If the content-hint check is too strict (e.g., a smart-quote typo in the read output vs the file), the model would get a hard error. Could be lifted as a soft pre-normalize for content-hint comparison only. **Defer until we have a concrete model failure to point to.**

- **Prompt density** — RimuruW's later commits densify the edit tool's prompt guidance. cgint has minimal prompt surface. Lifting this would mean re-authoring `tool-descriptions/edit.md`. **Defer — not a bug fix.**

---

## Order of work for 0.2.0

1. **Lift Jerry's compact/expanded diff** (smallest, isolated to `formatResultDiff` and its call sites).
2. **Lift Jerry's change summary line** (sits next to compact/expanded in the same render path).
3. **Lift RimuruW's bare hash prefix warning** (touches `src/hashline.ts`; isolated).
4. **Run full test suite** after each lift to confirm no regressions.
5. **Update `tool-descriptions/*.md`** if any user-visible behavior changes (the Jerry lifts will; the RimuruW lift won't).
6. **Bump version to 0.2.0** and update `CHANGELOG.md`.

Each lift should be a separate commit on the `monorepo-integration` branch (or a fresh branch off it). Use conventional commit style (`feat(edit): ...`, `fix(hashline): ...`) to match the upstream pattern.

---

## Reference: file mapping across the three repos

| Concern | RimuruW | Jerry | cgint | Our 0.1.0 |
|---|---|---|---|---|
| Hash algorithm | xxhashjs, line-only, `ZPMQVRWSNKTXJBYH` | FNV-1a, line+neighbors, hex | FNV-1a, line+neighbors, hex | FNV-1a, line+neighbors, hex (inherited) |
| Read output format | `LINE#HH:content` | `LINE#HH│content` | `LINEc│content` (single letter) | `LINEc│content` (inherited) |
| Edit ref shape | `op`, `pos`, `end`, `oldText`/`newText` | `{ range: [start, end], lines }` | `{ range: [start, end], lines, intent, rationale }` (full endpoint line required) | Same as cgint |
| Stale-anchor recovery | Hard reject | 3-tier: exact → fuzzy → 3-way merge | Stale-context warning + content validation | Same as cgint |
| Boundary dup detection | Trailing only | Symmetric | Symmetric (inherited) | Symmetric (inherited) |
| Undo | No | Yes (3 turns) | Yes (inherited) | Yes (inherited) |
| Write tool | No | No | Yes (with provenance) | Yes (inherited) |
| Max edits/call | Unlimited | Unlimited | 1–3 | 1–3 (inherited) |
| `[E_WOULD_EMPTY]` | Yes (>50) | Yes (>50) | Yes (>50) | Yes (inherited) |
| U+FFFD warning | No | Yes | Yes (inherited) | Yes (inherited) |
| Atomic write + symlink | Yes | Yes | Yes (inherited) | Yes (inherited) |
| Mutation queue | Yes | Yes | Yes (inherited) | Yes (inherited) |
| Package id in details | No | Yes | Yes (inherited) | Yes (inherited) |
| Provenance (intent/rationale) | No | No | Yes | Yes (inherited) |
| Compact/expanded diff | No | Yes (v0.10.1) | No (regression) | **PLANNED 0.2.0** |
| Change summary line | No | Yes (v0.10.1) | No (regression) | **PLANNED 0.2.0** |
| Bare `HH:` warning | No (issue #24 was fixed in `2f753f0`) | Inherited | Inherited (uses `:` not `│`) | **PLANNED 0.2.0** (adapted) |

---

## How to use this document in a future session

1. Start a new session. Give the agent the current state: "I'm working on `@k0valik/pi-hashline-edit` at branch `monorepo-integration`. The vendored cgint base is at commit `d003425`. The planned 0.2.0 work is documented in `pi-hashline-edit/monorepo_integration_plan.md`."
2. The agent should re-diff `tmp/hashline-edit-repos/pi-hashline-edit-jerry` and `tmp/hashline-edit-repos/pi-hashline-edit` against `pi-hashline-edit/src/`. The plan here is correct as of 0.1.0, but upstream may have moved; re-verify before lifting.
3. The three lifts listed in the "Order of work for 0.2.0" section are the priority. After they land, re-evaluate whether the deferred items (Unicode quote normalization, prompt density, module refactors) are still worth doing.

---

## Open questions

- **Should `tmp/hashline-edit-repos/` be removed once we're done with it?** It's a large checkout (~3 repos). The plan is to keep it for as long as synthesis work continues.
- **Should the upstream repos be pulled periodically to track new fixes?** Jerry's repo is the most likely to add features. cgint may also evolve. A quarterly diff-and-review would be cheap insurance.
- **The 4 WSL-incompatible tests** — should we add a `.skipIf(process.platform === 'win32' && fs.existsSync('/mnt/'))` guard, or leave them as-is and document in the README? The current approach (documented in README) is fine for a private monorepo.
