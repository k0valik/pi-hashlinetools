Read a text file or a supported image. Each text line is prefixed with a line number, a three-character URL-safe base64 checksum, and the content: `1abc│line content`. Copy the full line (with content) and use it as an endpoint in `edit` ranges.

Use `offset` and `limit` to page through. Default cap: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}; when truncated, the tail of the output tells you the next `offset`.

Pass `plain: true` to skip the line-number prefixes and return plain text — useful for exploration, documentation, and reference reads where the anchors are not needed.
