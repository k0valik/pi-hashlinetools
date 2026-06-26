Edit a text file with one or more changes in a single call.

### When to use each operation

- **`replace_text`** (`oldText` + `newText`) — substitute a unique substring. No line refs needed; use for whole-block rewrites. Tolerates trailing-whitespace and CRLF/LF differences silently.
- **`append`** (`pos` + `lines`) / **`prepend`** (`pos` + `lines`) — insert new lines after or before a known line.
- **`replace`** (`range` + `lines`) — change one or more contiguous lines. For whole-block rewrites spanning many lines, `replace_text` is simpler. A single-line `replace` uses the same line ref twice.

`range` and `pos` take a full line ref from your most recent `read` output (the `42#Xy0│...` format). Copy verbatim — do not paraphrase or trim.

For `append` / `prepend`, the anchor line stays in place; only the new content is added.

### Multi-edit batches

Submit one or more edits in a single call. `edits` is an array of objects — each entry has its own `op`. If you add or remove lines, the post-edit anchors show the new line numbers — use them to chain without re-reading. For wrong or unwanted edits, `undo` reverts the most recent change.
