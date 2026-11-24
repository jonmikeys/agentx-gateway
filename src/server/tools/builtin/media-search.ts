import { z } from "zod";
import { isHttpUrl, type SearxngResult, searchSearxng, uniqueBy } from "@/server/search/searxng";
import {
  createWebMediaItems,
  describeWebMedia,
  type NewWebMedia,
  toWebMediaEntry,
} from "@/server/services/web-media";
import {
  type BuiltinTool,
  type BuiltinToolContext,
  type BuiltinToolResult,
  needsSearch,
} from "@/server/tools/builtin/types";
import {
  isYtDlpAvailable,
  youtubeVideoId,
  youtubeWatchUrl,
} from "@/server/tools/builtin/video-resolver";
import { clip } from "@/server/tools/builtin/web-search";

export const MEDIA_SEARCH_DEFAULT_RESULTS = 5;
export const MEDIA_SEARCH_MAX_RESULTS = 10;

export const mediaSearchArgsSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(400),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEDIA_SEARCH_MAX_RESULTS)
    .default(MEDIA_SEARCH_DEFAULT_RESULTS),
});

export type MediaSearchArgs = z.infer<typeof mediaSearchArgsSchema>;

export function mediaSearchParameters(noun: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: `What ${noun} to search for.` },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MEDIA_SEARCH_MAX_RESULTS,
        description: `How many results to return (default ${MEDIA_SEARCH_DEFAULT_RESULTS}).`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  };
}

/** A SearXNG image result as a temporary item, or undefined when it has no usable image URL. */
export function imageFromResult(result: SearxngResult): NewWebMedia | undefined {
  if (!isHttpUrl(result.img_src)) return undefined;
  return {
    kind: "image",
    title: clip(result.title, 200),
    sourcePageUrl: isHttpUrl(result.url) ? result.url : undefined,
    mediaUrl: result.img_src,
    thumbnailUrl: isHttpUrl(result.thumbnail_src) ? result.thumbnail_src : undefined,
    resolution: typeof result.resolution === "string" ? clip(result.resolution, 40) : undefined,
  };
}

/** Search engine lengths: `"1:23"`, `"1:02:05"`, `"88.0"` (seconds) or a number. */
export function parseDuration(length: unknown): number | undefined {
  if (typeof length === "number")
    return Number.isFinite(length) && length > 0 ? Math.round(length) : undefined;
  if (typeof length !== "string") return undefined;
  const text = length.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Math.round(Number(text));
    return seconds > 0 ? seconds : undefined;
  }
  if (!/^\d{1,3}(:\d{1,2}){1,2}$/.test(text)) return undefined;
  const seconds = text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return seconds > 0 ? seconds : undefined;
}

/**
 * A SearXNG video result as a temporary item, YouTube only (from the result URL or its embed
 * URL). The canonical watch URL is what yt-dlp resolves later; other sites are skipped.
 */
export function videoFromResult(result: SearxngResult): NewWebMedia | undefined {
  const id = youtubeVideoId(result.url) ?? youtubeVideoId(result.iframe_src);
  if (!id) return undefined;
  const thumbnail = [result.thumbnail, result.img_src, result.thumbnail_src].find(isHttpUrl);
  const watchUrl = youtubeWatchUrl(id);
  return {
    kind: "video",
    title: clip(result.title, 200).replace(/\s+-\s+YouTube$/i, ""),
    sourcePageUrl: watchUrl,
    mediaUrl: watchUrl,
    thumbnailUrl: thumbnail,
    durationSeconds: parseDuration(result.length),
  };
}

/**
 * Searches one SearXNG category, stores the usable results as temporary media items for the
 * session, and returns them with their ids. The ids work wherever a media catalogue id does
 * (`GET /v1/media/{id}`, the client's `show_image` / `show_video`).
 */
export async function runMediaSearch(
  category: "images" | "videos",
  toItem: (result: SearxngResult) => NewWebMedia | undefined,
  args: MediaSearchArgs,
  context: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  if (!context.search) throw new Error("web search is not configured");
  if (!context.sessionId || !context.apiKeyId) {
    throw new Error("media search needs a client session");
  }
  const raw = await searchSearxng({
    baseUrl: context.search.url,
    query: args.query,
    category,
    safesearch: context.search.safesearch,
    signal: context.signal,
    fetchImpl: context.fetchImpl,
  });
  const items = uniqueBy(
    raw.map(toItem).filter((item): item is NewWebMedia => item !== undefined),
    (item) => item.mediaUrl,
  ).slice(0, args.max_results);
  if (items.length === 0) return { text: "No results found.", isError: false };
  const rows = await createWebMediaItems(context.sessionId, context.apiKeyId, items);
  const results = rows.map((row) => ({
    media_id: row.id,
    title: toWebMediaEntry(row, context.baseUrl).name,
    description: describeWebMedia(row),
    source_page: row.sourcePageUrl,
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.durationSeconds !== null ? { duration_seconds: row.durationSeconds } : {}),
  }));
  return { text: JSON.stringify({ results }), isError: false };
}

export const VIDEO_PLAYBACK_UNAVAILABLE = "video playback needs yt-dlp, which was not found";

export const videoSearchTool: BuiltinTool<MediaSearchArgs> = {
  name: "video_search",
  description:
    "Search YouTube for videos. Each result has a media_id you can play like a media library " +
    "item (for example with show_video). A video is fetched when first played; some turn out " +
    "unplayable (for example age-restricted), which shows up as an error then. The ids last " +
    "for this conversation only.",
  parameters: mediaSearchParameters("videos"),
  args: mediaSearchArgsSchema,
  availability: (context) => {
    const search = needsSearch(context);
    if (search !== true) return search;
    return isYtDlpAvailable() ? true : VIDEO_PLAYBACK_UNAVAILABLE;
  },
  execute: (args, context) => runMediaSearch("videos", videoFromResult, args, context),
};

export const imageSearchTool: BuiltinTool<MediaSearchArgs> = {
  name: "image_search",
  description:
    "Search the web for images. Each result has a media_id you can show like a media library " +
    "item (for example with show_image). The ids last for this conversation only.",
  parameters: mediaSearchParameters("images"),
  args: mediaSearchArgsSchema,
  availability: needsSearch,
  execute: (args, context) => runMediaSearch("images", imageFromResult, args, context),
};
