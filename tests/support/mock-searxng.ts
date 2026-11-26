import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Mock SearXNG for tests, e2e and screenshots: `GET /search?format=json&categories=…` answers
 * canned results per category, `format` other than json answers 403 (like a real instance
 * without json in `search.formats`). Queries are recorded. Self-contained (no `@/` imports).
 */
export interface RecordedSearch {
  q: string;
  categories: string;
  safesearch: string;
  format: string;
}

export interface MockSearxng {
  url: string;
  port: number;
  searches: RecordedSearch[];
  /** Replaces the canned results of one category until `reset()`. */
  setResults: (category: string, results: Record<string, unknown>[]) => void;
  /** Makes every search answer this HTTP status until `reset()`. */
  failWith: (status: number | undefined) => void;
  reset: () => void;
  close: () => Promise<void>;
}

export interface MockSearxngOptions {
  port?: number;
  /** Base URL that image/video result URLs point at (for example a mock media server). */
  mediaBaseUrl?: string;
}

export function defaultSearchResults(mediaBaseUrl = "https://media.example.com") {
  return {
    general: [
      {
        title: "Red panda - Wikipedia",
        url: "https://en.wikipedia.org/wiki/Red_panda",
        content:
          "The red panda (Ailurus fulgens) is a small mammal native to the eastern Himalayas.",
        engine: "duckduckgo",
      },
      {
        title: "Red panda facts",
        url: "https://www.example.org/red-panda",
        content: "Red pandas spend most of their lives in trees.",
        engine: "brave",
      },
      // Duplicates and unusable URLs are dropped by the gateway.
      { title: "Duplicate", url: "https://en.wikipedia.org/wiki/Red_panda", content: "dup" },
      { title: "No URL", content: "missing url" },
      { title: "Not http", url: "ftp://example.com/file", content: "ftp" },
      ...Array.from({ length: 12 }, (_, index) => ({
        title: `Result ${index + 3}`,
        url: `https://www.example.org/result-${index + 3}`,
        content: `Snippet ${index + 3}`,
      })),
    ],
    images: [
      {
        title: "Red panda in a tree",
        url: "https://commons.wikimedia.org/wiki/File:Red_panda.jpg",
        img_src: `${mediaBaseUrl}/red-panda.png`,
        thumbnail_src: `${mediaBaseUrl}/red-panda-thumb.png`,
        resolution: "1024 × 768",
        engine: "bing images",
      },
      {
        title: "Red panda eating bamboo",
        url: "https://www.example.org/bamboo",
        img_src: `${mediaBaseUrl}/missing.png`,
        thumbnail_src: `${mediaBaseUrl}/red-panda-thumb.png`,
        resolution: "6000x4000",
        engine: "duckduckgo images",
      },
    ],
    videos: [
      {
        title: "Red panda playtime - YouTube",
        url: "https://www.youtube.com/watch?v=redpanda001",
        thumbnail: `${mediaBaseUrl}/red-panda-thumb.png`,
        length: "1:23",
        author: "Zoo channel",
        engine: "youtube",
      },
      // Not YouTube: skipped (video playback supports YouTube only).
      {
        title: "Red panda in the snow",
        url: "https://vimeo.com/383815620",
        thumbnail: "https://i.vimeocdn.com/video/1.jpg",
        length: "88.0",
        engine: "vimeo",
      },
      // YouTube found through another engine, recognised by its embed URL.
      {
        title: "Red panda, no MP4",
        url: "https://www.bing.com/videos/riverview/relatedvideo?q=red+panda",
        iframe_src: "https://www.youtube-nocookie.com/embed/noformat001",
        length: "88.0",
        engine: "bing videos",
      },
    ],
  } as Record<string, Record<string, unknown>[]>;
}

export async function startMockSearxng(options: MockSearxngOptions = {}): Promise<MockSearxng> {
  const searches: RecordedSearch[] = [];
  let overrides: Record<string, Record<string, unknown>[]> = {};
  let failStatus: number | undefined;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      response.writeHead(200).end("OK");
      return;
    }
    if (url.pathname !== "/search") {
      response.writeHead(404).end();
      return;
    }
    const recorded: RecordedSearch = {
      q: url.searchParams.get("q") ?? "",
      categories: url.searchParams.get("categories") ?? "general",
      safesearch: url.searchParams.get("safesearch") ?? "",
      format: url.searchParams.get("format") ?? "html",
    };
    searches.push(recorded);
    if (recorded.format !== "json") {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (failStatus) {
      response.writeHead(failStatus).end();
      return;
    }
    const defaults = defaultSearchResults(options.mediaBaseUrl);
    const results = overrides[recorded.categories] ?? defaults[recorded.categories] ?? [];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ query: recorded.q, number_of_results: 0, results }));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    searches,
    setResults: (category, results) => {
      overrides = { ...overrides, [category]: results };
    },
    failWith: (status) => {
      failStatus = status;
    },
    reset: () => {
      searches.length = 0;
      overrides = {};
      failStatus = undefined;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
