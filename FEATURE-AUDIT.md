w# Feature Expansion Audit — pi-hashline-edit

## Baseline

Our `pi-hashline-edit` (cgint's `pi-line-edit` → `@k0valik/pi-hashline-edit`, vendored from oh-my-pi, MIT) has:

| Feature | Status |
|---|---|
| FNV-1a 2-char hash + surrounding-line context | ✅ |
| `LINE#ID│` format, full endpoint refs | ✅ |
| Replace ops only (pos/end range) | ✅ |
| 1-3 edits per call (configurable max) | ✅ |
| Content-based fuzzy relocate ±15 lines (Layers 1-3) | ✅ |
| Asymmetric shift rejection | ✅ |
| Bare hash prefix warning | ✅ |
| Display prefix rejection (E_INVALID_PATCH) | ✅ |
| Boundary duplication detection | ✅ |
| Unicode escape warning | ✅ |
| Noop detection | ✅ |
| Undo (single-step) | ✅ |
| Preview diff rendering (compact/expanded) | ✅ |
| Optional intent/rationale provenance | ✅ |
| File mutation queue wrapping | ✅ |
| Snapshot ID tracking | ✅ |
| BOM/CRLF handling | ✅ |
| Atomic writes | ✅ |
| Internal write tool replacement | ✅ |
| Public checksum (a-z) in read output | ✅ |

---

## Upstream Feature Inventory

### 1. pi-readseek (jarkkojs/pi-readseek)
**702-line edit.ts + 726-line hashline.ts**

| Feature | Description | Effort |
|---|---|---|
| XXHash 3-char hashing | xxhash-wasm based, 3-char hashes | Medium |
| Hash-index relocation | Relocates anchors by matching hash in adaptive window (20-100 lines) | Medium |
| Fuzzy content recovery | Token similarity (0.8 threshold, 50-line scan) when anchor has content hint | Medium |
| "Did you mean?" suggestions | Similar line suggestions on mismatch | Low |
| Syntax regression validation | Tree-sitter based; warn/block/off modes | High |
| `replace_text` op | Exact substring replacement alongside hashline ops; optional all/fuzzy modes | Medium |
| `set_line`/`replace_lines`/`insert_after` variants | More granular edit types | Medium |
| Merge detection | Detects when model absorbed continuation lines into replacement | Medium |
| `restoreOldWrappedLines` | Detects model wrapping single line into multiple; restores original | Medium |
| `restoreIndent` | Restores indentation to match original | Low |
| Duplicate target detection | Deduplicates edits targeting same anchor | Low |
| Confusable hyphens normalization | Unicode → ASCII hyphens | Low |
| Strip newline prefixes (silent) | Heuristic prefix stripping from content | Low |
| `wasReadInSession` check | Validates file was read before editing | Low |
| Post-edit verification | Re-read after write to verify | Low |
| Difftastic integration | Semantic diff classification | High |

### 2. pi-hashline-tools (davehardy20/pi-hashline-tools)
**653-line hashline-utils.ts + 22-line constants**

| Feature | Description | Effort |
|---|---|---|
| `append`/`prepend`/`replace` ops | Three canonical operations | **Low** |
| BOF/EOF insertion | append/prepend without pos → file boundary insertion | **Low** |
| Conservative remap suggestions | `buildConservativeRemapSuggestions` — finds unique hash match for stale anchor | Low |
| Hash-based line suggestion | `suggestLineForHash` — finds current line for a hash | Low |
| Overlap detection | Detects conflicting overlapping ranges | Low |
| Mixed-op conflict detection | Detects append/prepend inside replace ranges | Low |

### 3. pi-hashline-readmap (coctostan/pi-hashline-readmap)
**746-line edit.ts + 747-line hashline.ts** — fork of pi-readseek

| Feature | Description | Effort |
|---|---|---|
| Doom loop detection | Detects repeated tool call patterns | High |
| Context hygiene metadata | Attaches metadata to tool outputs for stale reasoning | High |

> Note: shares most features with pi-readseek. Unique additions are large infrastructure items not specific to hashline editing.

### 4. pi-blackbytes (cuongntr/pi-blackbytes)
**546-line index.ts + supporting modules**

| Feature | Description | Effort |
|---|---|---|
| `replace_text` op | Exact-unique substring replacement | Medium |
| `insert_after`/`insert_before`/`replace_range` aliases | Clearer intent names, canonicalize to append/prepend/replace | Low |
| **Post-edit verification with rollback** | Reads file back, compares byte-for-byte, rolls back + restores on mismatch | **Medium** |
| `delete` shortcut | `delete: true` to delete file | Low |
| `rename` option | Rename/move file to new path | Low |
| Structured error codes | `ERROR_CODES` enum with consistent `[CODE] message` formatting | **Low** |
| Text/anchor overlap detection | Prevents mixed text+anchor edits from conflicting | Medium |
| Occurrence counting | Ensures `replace_text.oldText` matches exactly once | Medium |
| Read renderer override | Overrides built-in read to show hash anchors | High |

---

## Recommended Lifts: Priority Matrix

### Tier 1 — High Value, Low Effort (do first)

| # | Feature | From | Why | ~LOC |
|---|---|---|---|---|
| **A** | **`append` / `prepend` ops** | pi-hashline-tools | Single most-requested missing op. Our replace-only model forces awkward range workarounds. Simple splice operations. | ~30 |
| **B** | **BOF/EOF insertion** | pi-hashline-tools | append/prepend without pos → insert at file boundaries. Trivial addition. | ~20 |
| **C** | **Structured error codes** | pi-blackbytes | Consistent `[E_CODE] message` formatting improves LLM error recovery. Our errors are already well-structured; just standardize the prefix. | ~30 |
| **D** | **Edit conflict detection** | pi-hashline-tools | Overlapping range detection catches model mistakes that currently produce corrupted output silently. | ~30 |
| **E** | **Post-edit verification with rollback** | pi-blackbytes | Safety net: reads file back after write, compares byte-for-byte, rolls back + restores original on mismatch. Prevents silent corruption from FS-level failures. Already well-implemented (80 lines). | ~80 |

### Tier 2 — Medium Value, Medium Effort

| # | Feature | From | Why | ~LOC |
|---|---|---|---|---|
| **F** | **`replace_text` op** | pi-blackbytes / pi-readseek | Exact-unique substring replacement. Complements hashline ops for identifier renames, literal tweaks. Blackbytes version is cleaner (exact match only, multi-match rejected). | ~60 |
| **G** | **Confusable hyphens normalization** | pi-readseek | 8-line regex. Catches model copy-pasting Unicode hyphens from web/PDF into code. | ~10 |
| **H** | **Hash-index relocation** | pi-readseek | Build hash→lines index, relocate anchors by matching stale hash in window. Complements our content-based fuzzy relocate — covers cases where content changes slightly but hash matches. | ~50 |
| **I** | **Duplicate target detection** | pi-readseek | Don't silently apply multiple edits to same anchor — warn or reject. Already partially covered by noop detection but explicit. | ~30 |
| **J** | **Merge detection (absorbed continuation)** | pi-readseek | When model merges a continuation line into its replacement, detect and handle gracefully. Prevents corruption from "the model absorbed the next line." | ~60 |

### Tier 3 — Lower Priority / Higher Complexity

| # | Feature | From | Why deferred |
|---|---|---|---|
| Syntax regression validation | pi-readseek | Tree-sitter dependency (WASM), language-dependent parsers, complex setup. Higher blast radius than value. |
| Difftastic integration | pi-readseek | External binary dependency. Nice-to-have semantic diff classification. |
| `restoreOldWrappedLines` | pi-readseek | Heuristic; false positives possible. Model wrapping behavior changes with model version. Revisit if wrapping becomes a persistent issue. |
| Doom loop detection | pi-hashline-readmap | 216 LOC, session-state tracking, orthogonal to edit tool robustness. |
| Context hygiene | pi-hashline-readmap | 848 LOC, telemetry infrastructure, not edit-specific. |
| Read renderer override | pi-blackbytes | Would conflict with our read tool architecture. |
| XXHash migration | pi-readseek | Our FNV-1a works fine; xxhash-wasm adds native dependency. Not worth the risk. |

---

## Rejected Approaches

| Approach | Why rejected |
|---|---|
| Porting pi-readseek's entire edit.ts | 700+ lines with tight coupling to readseek infrastructure (mapper, symbol-lookup, parser-loader). Would require pulling in half the repo. Lift individual features instead. |
| Switching hash algorithm to XXHash | Adds native WASM dependency (xxhash-wasm). FNV-1a is deterministic, runs everywhere, no deps. The 2-char vs 3-char hash difference is cosmetic — collision probability is already negligible for file-sized documents. |
| Adopting `set_line`/`replace_lines`/`insert_after` schema | Our `range[pos, end]` + `lines[]` schema is equivalent and simpler. Adding more schema variants increases LLM confusion without adding capability. The `append`/`prepend` ops cover the real missing operations. |
| Silent prefix stripping (pi-readseek heuristic mode) | We already have strict rejection with a clear error. Silent stripping masks model mistakes. |

---

## Implementation Plan

```
Branch: 0.3.0-robustness
Atomic commits, one feature at a time:

1. [Tier 1-A] append/prepend ops → verify: new test passes
2. [Tier 1-B] BOF/EOF insertion → verify: new test passes  
3. [Tier 1-C] Structured error codes → verify: existing tests still pass
4. [Tier 1-D] Edit conflict detection → verify: conflict cases caught
5. [Tier 1-E] Post-edit verification + rollback → verify: corrupt write rolled back
6. [Tier 2-F] replace_text op → verify: exact unique match works
7. [Tier 2-G] Confusable hyphens → verify: Unicode hyphens normalized
8. [Tier 2-H] Hash-index relocation → verify: complements content relocate
9. [Tier 2-I] Duplicate target detection → verify: duplicate warned
10. [Tier 2-J] Merge detection → verify: absorbed lines caught
```

### Constraints

- [x] No external npm dependencies (xxhash-wasm, tree-sitter NOT added)
- [x] Must work in WSL
- [x] Must preserve existing test pass rate
- [x] Must not break existing schema (additive only)
- [x] Must not require config files mid-development


## Current Tool Surface

We register **4 tools**, all replacing built-in pi tools:

| Tool | What the LLM sees | Schema surface |
|---|---|---|
| **`read`** | `LINEc│content` with a-z freshness checksums. `offset`, `limit`, `raw` params. 496 chars | `{path, offset?, limit?, raw?}` |
| **`edit`** | Range-based replacement with full endpoint refs. Max 3 edits/call. Optional intent/rationale. 2,116 chars | `{path, edits: [{range: [start, end], lines: [...]}]}` |
| **`write`** | Create/overwrite files. Optional intent/rationale. 819 chars | `{path, content, intent?, rationale?}` |
| **`undo`** | Revert last edit within 3 turns. 348 chars | `{}` (no params) |

Total LLM surface: **~4,400 characters** across descriptions, snippets, and guidelines.

---

## After Tiers 1+2: Zero New Tools

Every feature folds into the existing `edit` tool. Here's what changes:

### Edit schema — backward-compatible extension

```typescript
// Current (unchanged path, op defaults to "replace"):
{ range: [start, end], lines: [...] }

// New ops added:
{ op: "append",  pos: "42f│const x = 1;", lines: [...] }  // insert after line 42
{ op: "prepend", pos: "42f│const x = 1;", lines: [...] }  // insert before line 42
{ op: "append",  lines: [...] }                            // EOF (no pos)
{ op: "prepend", lines: [...] }                            // BOF (no pos)
{ op: "replace_text", oldText: "foo", newText: "bar" }     // exact-unique substring
```

`pos` uses the same full endpoint line format as `range` start — so stale-anchor recovery still works. `append`/`prepend` without `pos` = file boundary insertion.

### What's invisible to the LLM (no surface change)

| Feature | Where it lives |
|---|---|
| Structured error codes `[E_CODE]` | Error formatting only |
| Edit conflict detection | Validation in `execute()` |
| Post-edit verification + rollback | Internal safety net |
| Confusable hyphens normalization | Content preprocessing |
| Hash-index relocation | Internal anchor recovery (Layer 4) |
| Duplicate target detection | Warning generation |
| Merge detection | Heuristic in apply |

### What the LLM sees change

| Component | Before | After | Delta |
|---|---|---|---|
| Edit description | 2,116 chars | ~2,800 chars | +~700 |
| Edit snippet | 222 chars | ~350 chars | +~130 |
| Schema params | `range`, `lines`, `intent?`, `rationale?` | + `op?`, `pos?`, `oldText?`, `newText?` | +4 optional fields |
| Write tool | unchanged | unchanged | 0 |
| Read tool | unchanged | unchanged | 0 |
| Undo tool | unchanged | unchanged | 0 |

**Net result: 4 tools → 4 tools. ~800 chars added to edit's surface. No new tool registrations.**

---

### The one design question: `replace_text` as op vs tool

`replace_text` is the odd one out — it doesn't use hashline anchors at all. It's "find this exact string, replace with that string." Two options:

| | Fold into `edit` as op | Separate `replace` tool |
|---|---|---|
| LLM surface | +1 op in edit schema | +1 tool (~500 chars new surface) |
| Confusion risk | LLM might use `replace_text` when it should use hashline | LLM clearly picks the right tool |
| Error handling | Mixed error codes in one tool | Clean separation |
| Code complexity | One file, one execute() | New file, new registration |

should be a separate "optional" tool, that we can turn on or off the registration for for testing purposes.