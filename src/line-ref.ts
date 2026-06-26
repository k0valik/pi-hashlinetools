import { computeLineHash } from "./hashline";

export function getVisibleLineCount(content: string): number {
  if (content.length === 0) return 0;
  const fileLines = content.split("\n");
  return content.endsWith("\n") ? fileLines.length - 1 : fileLines.length;
}

/**
 * Returns the first 2 hex characters of the hash as the public checksum.
 * This preserves the full 256-value collision resistance of the internal hash.
 */
export function publicChecksumFromHash(hash: string): string {
  return hash;
}

export function computePublicLineChecksum(
  fileLines: string[],
  lineNumber: number,
): string {
  return publicChecksumFromHash(computeLineHash(fileLines, lineNumber - 1));
}

export function formatPublicLineRef(
  fileLines: string[],
  lineNumber: number,
): string {
  return `${lineNumber}${computePublicLineChecksum(fileLines, lineNumber)}`;
}

export type PublicLineRef = {
  line: number;
  checksum?: string;
  contentHint?: string;
};

export function parsePublicLineRef(ref: string): PublicLineRef | undefined {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

  // 3-char base64 checksum format with # separator: NN####│content
  // (matches the new format emitted by appendAutoRead / formatHashlineRegion)
  const base64Hashed = core.match(
    /^(\d+)#([A-Za-z0-9_-]{3})(?:\s*[│|:](.*))?$/,
  );
  if (base64Hashed) {
    return {
      line: Number.parseInt(base64Hashed[1]!, 10),
      checksum: base64Hashed[2]!,
      ...(base64Hashed[3] !== undefined
        ? { contentHint: base64Hashed[3]! }
        : {}),
    };
  }

  // 3-char base64 checksum format without # separator: NN###│content
  // (matches the format emitted by the read tool's formatPublicLineRef)
  const base64Checked = core.match(
    /^(\d+)([A-Za-z0-9_-]{3})(?:\s*[│|:](.*))?$/,
  );
  if (base64Checked) {
    return {
      line: Number.parseInt(base64Checked[1]!, 10),
      checksum: base64Checked[2]!,
      ...(base64Checked[3] !== undefined
        ? { contentHint: base64Checked[3]! }
        : {}),
    };
  }

  // Legacy: 2-char hex checksum format: NNxx│content
  const hexChecked = core.match(/^(\d+)([0-9a-fA-F]{2})(?:\s*[│|:](.*))?$/);
  if (hexChecked) {
    return {
      line: Number.parseInt(hexChecked[1]!, 10),
      checksum: hexChecked[2]!,
      ...(hexChecked[3] !== undefined ? { contentHint: hexChecked[3]! } : {}),
    };
  }

  // Legacy: single-letter checksum format: NNc│content
  const letterChecked = core.match(/^(\d+)([a-z])(?:\s*[│|:](.*))?$/);
  if (letterChecked) {
    return {
      line: Number.parseInt(letterChecked[1]!, 10),
      checksum: letterChecked[2]!,
      ...(letterChecked[3] !== undefined
        ? { contentHint: letterChecked[3]! }
        : {}),
    };
  }

  const bare = core.match(/^(\d+)$/);
  if (bare) {
    return { line: Number.parseInt(bare[1]!, 10) };
  }

  return undefined;
}
