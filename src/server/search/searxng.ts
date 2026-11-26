/**
 * Minimal SearXNG JSON client (docs/web-search.md). The instance must list `json` in
 * `search.formats`. Safe search is a deployment setting passed on every query; callers never
 * take it from the model.
 */

export type SearchCategory = "general" | "images" | "videos";

/** One SearXNG result; only the fields the built-in tools read. Every field is optional. */
export interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  resolution?: string;
  iframe_src?: string;
  length?: string | number | null;
  author?: string;
  publishedDate?: string | null;
}

export interface SearxngQuery {
  baseUrl: string;
  query: string;
  category: SearchCategory;
  safesearch: 0 | 1 | 2;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const SEARCH_TIMEOUT_MS = 10_000;

/** A failure the model can read: the message never contains the query or the backend URL. */
export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

export async function searchSearxng(input: SearxngQuery): Promise<SearxngResult[]> {
  const url = new URL("search", `${input.baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("q", input.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", input.category);
  url.searchParams.set("safesearch", String(input.safesearch));

  const timeout = AbortSignal.timeout(input.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    if (timeout.aborted) throw new SearchError("The search backend did not answer in time.");
    throw new SearchError("The search backend is unreachable.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403) {
      throw new SearchError(
        "The search backend refused JSON output (add json to search.formats in SearXNG).",
      );
    }
    throw new SearchError(`The search backend failed (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SearchError("The search backend returned an invalid response.");
  }
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results.filter(
    (entry): entry is SearxngResult => typeof entry === "object" && entry !== null,
  );
}

/** Keeps the first item per key, dropping items without one, in order. */
export function uniqueBy<T>(items: T[], key: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(item);
  }
  return out;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
