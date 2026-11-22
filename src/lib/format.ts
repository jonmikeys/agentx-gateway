/** Short human duration: `850 ms`, `1.2 s`, `2 min 5 s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** First 8 characters of a UUID, for compact display. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
