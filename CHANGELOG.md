# Changelog

All notable changes to `@k0valik/pi-hashline-edit` are documented here.

This changelog starts at the monorepo port. The history of the upstream forks (cgint/pi-line-edit, JerryAZR/pi-hashline-edit, RimuruW/pi-hashline-edit) is preserved in the git history of this repo and in the vendored analysis documents at the package root.

---

## 0.2.0 — 2025-06-15

**Synthesis release.** Lifts the highest-value missing fixes from JerryAZR and RimuruW that cgint/pi-line-edit did not carry forward.

### Added

- **Compact/expanded diff truncation in the result card.** The result-side render now respects the caller's `expanded` flag: 16 lines in compact mode (with `... N more diff lines` ellipsis), full diff in expanded mode. The preview-side render already had this; the result path was a regression from cgint's refactor. Mirrors Jerry v0.10.1.
- **Change summary line.** Result renders now include a styled `[accent]X insertions(+), Y deletion(-)[/accent]` line between the diff and the warnings. Singular grammar for 1, plural for >1. Data is already populated by `edit-response.ts` from the apply step. Mirrors Jerry v0.10.1.
- **Bare hash prefix warning.** When the model copies a public checksum letter from read output into `lines` while dropping the `LINE#` part (e.g. `["f│new content"]` when read output showed `42f│...`), a warning is added to the result. The full `LINE#HH│` form was already rejected by `assertNoDisplayPrefixes`; the bare form is ambiguous (a single letter is too short to disambiguate from real content) and is therefore warned, not rejected. The warning fires when any suspect letter matches a real public checksum in the file, or when ≥ 2 lines look like bare prefixes. The edit is still applied verbatim — strict semantics, no silent patching. Adapted from RimuruW issue #25 to our single-letter public alphabet.

### Changed

- `buildAppliedChangedResultText` signature now takes `expanded: boolean` as a 4th parameter. The previous 3-arg form called the now-removed `formatResultDiff` helper; the truncation logic is inlined.
- `formatResultDiff` removed (its 3 lines were inlined into the new truncated block in `buildAppliedChangedResultText`).
- `src/package-info.ts` and `package.json` version bumped to `0.2.0`.

### Tests

- New: `test/tools/edit.render.test.ts` (6 tests) covering compact/expanded truncation, change summary singular/plural, noop path, section ordering.
- New: `test/core/hashline.bare-hash-prefix.test.ts` (7 tests) covering the no-warning / one-match / two-prefixes / mixed-content paths, separator tolerance (│/|/:), and that the edit is still applied despite the warning.

Test count: 238 (234 passing, 4 environment-specific WSL/Windows-mount failures unchanged from 0.1.0).

---

## 0.1.0 — 2025-06-15

**Initial monorepo port.** Vendored from [cgint/pi-line-edit](https://github.com/cgint/pi-line-edit) at commit `d003425 fix(edit): require full endpoint refs`.

### Added

- The `@k0valik/pi-hashline-edit` package itself, registered in the monorepo's `pi.extensions`.
- Everything from cgint's `pi-line-edit@0.1.0`:
  - `read` tool with `LINEc│content` output, `raw: true` mode, U+FFFD warning for non-UTF-8 files, image/binary/directory guards.
  - `edit` tool with full-endpoint-ref requirement (`[E_FULL_REF_REQUIRED]`), strict content-hint validation (`[E_LINE_CONTENT_MISMATCH]`), stale-context warning (`[W_STALE_CONTEXT]`), 1–3 edits per call (`[E_TOO_MANY_EDITS]`), symmetric boundary-duplication detection, `[E_WOULD_EMPTY]` guard for files >50 lines, `[E_INVALID_PATCH]` for display-prefix contamination, `[E_EMPTY_FILE]` guard with write-tool redirect, `[E_RANGE_OOB]` / `[E_BAD_RANGE]` for invalid ranges.
  - `write` tool with required `intent` and `rationale` provenance.
  - `undo` tool that reverts the most recent edit (within 3 turns).
  - FNV-1a inline hash with line+neighbor context, single-letter checksum modulo 26.
  - Atomic writes with symlink/hardlink awareness, per-file mutation queue, BOM and line-ending preservation.
  - Edit provenance rendering (intent + rationale surfaced in the tool call).
  - Per-tool package identifier in result details.

### Changed (from upstream cgint@0.1.0)

- **Package renamed** from `pi-line-edit` to `@k0valik/pi-hashline-edit`. Version reset to `0.1.0`.
- `package.json` adapted for the monorepo:
  - Dropped `repository` (private monorepo).
  - Dropped `author` and `publishConfig` (private monorepo).
  - Bumped dev `@earendil-works/pi-coding-agent` from `^0.74.0` to `^0.75.5` to match the monorepo.
  - Bumped dev `vitest` from `^3.0.0` to `^3.2.1` to match the monorepo.
  - Bumped runtime `@earendil-works/pi-coding-agent` peer to `>=0.74.0` (unchanged).
- Re-authored `README.md` with full provenance attribution (oh-my-pi → RimuruW → JerryAZR → cgint → us).
- Re-authored this `CHANGELOG.md`.
- `src/package-info.ts` now reports `name: "@k0valik/pi-hashline-edit"`.

### Removed (from upstream cgint@0.1.0)

- `.github/workflows/test.yml` — cgint's CI workflow (monorepo has its own).
- `.vscode/settings.json` — cgint's editor config.
- `AGENTS.md` and `CLAUDE.md` symlink — Jerry's repo guide (was a Jerry-original artifact inherited by cgint; not applicable to a monorepo member).
- `package-lock.json` — npm lockfile (the monorepo uses pnpm with a single root `pnpm-lock.yaml`).
- `package.json` keys: `repository`, `author`, `publishConfig`.

### Kept (intentionally, for reference)

- The cgint/Jerry analysis documents at the package root: `COMPARISON-core-mechanics.md`, `CONSISTENCY-REVIEW.md`, `ISSUE-silent-edit-failures.md`, `REF-edit-modes.md`, `REFACTOR.md`, `STATS-edit-usage.md`, `TEST-GUIDE.md`, `analyze-boundary-dups.py`, `analyze-edit-usage.py`, `profiling/`. These document the failure modes the upstream authors discovered and the design tradeoffs they made. They are not part of the build but are kept for future maintainers.
- `README.md` and this `CHANGELOG.md` were replaced.

### Upstream context

This version does **not** include the synthesis work planned for follow-up releases — the Jerry/RimuruW lifts that were identified during the planning phase. See [`monorepo_integration_plan.md`](./monorepo_integration_plan.md) for the tracked work.

Specifically, the following features are **not** in 0.1.0: **all three were lifted in 0.2.0** (see above).

---

## Earlier versions

See the git history of this repo (cgint/pi-line-edit) and the upstream repos for changes prior to 0.1.0:

- [cgint/pi-line-edit](https://github.com/cgint/pi-line-edit) — 12 commits ahead of JerryAZR/pi-hashline-edit, the source of this port.
- [JerryAZR/pi-hashline-edit](https://github.com/JerryAZR/pi-hashline-edit) — 31 commits ahead of RimuruW/pi-hashline-edit; introduced the `│` separator, context hashing, undo, and 3-tier stale-anchor recovery.
- [RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) — the original pi-coding-agent port of the [oh-my-pi](https://github.com/can1357/oh-my-pi) concept.
