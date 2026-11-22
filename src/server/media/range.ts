/** Result of evaluating an HTTP `Range` header against a representation of `size` bytes. */
export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE_RANGE = /^(\d*)-(\d*)$/;

/**
 * Parses a `Range` header. Supports one `bytes=a-b`, `bytes=a-` or `bytes=-n` range.
 * Anything that is not a single well-formed byte range (other units, several ranges, garbage)
 * is served in full, which RFC 9110 allows. A well-formed range that cannot be satisfied
 * (start past the end, `bytes=-0`, `bytes=5-2`) is `unsatisfiable`: the caller answers `416`
 * with a `Content-Range` of `bytes *` followed by `/size`.
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match || match[1].includes(",")) return { kind: "full" };
  const spec = SINGLE_RANGE.exec(match[1].trim());
  if (!spec || (!spec[1] && !spec[2])) return { kind: "full" };

  const [, first, last] = spec;
  if (!first) {
    const count = Number(last);
    if (count === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(size - count, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  if (start >= size || end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}
