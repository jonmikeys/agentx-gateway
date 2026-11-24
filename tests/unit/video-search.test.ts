import { afterEach, describe, expect, it } from "vitest";
import { parseDuration, videoFromResult } from "@/server/tools/builtin/media-search";
import { listBuiltinTools } from "@/server/tools/builtin/registry";
import {
  buildYtDlpArgs,
  parseYtDlpOutput,
  setYtDlpForTests,
  YTDLP_FORMAT,
  ytDlpErrorMessage,
} from "@/server/tools/builtin/video-resolver";

afterEach(() => setYtDlpForTests(undefined));

describe("video_search results", () => {
  it.each([
    ["1:23", 83],
    ["00:14", 14],
    ["1:02:05", 3725],
    ["88.0", 88],
    [61.6, 62],
    ["", undefined],
    ["None", undefined],
    [null, undefined],
    ["0:00", undefined],
  ])("parses length %s", (length, seconds) => {
    expect(parseDuration(length)).toBe(seconds);
  });

  it("keeps the page URL for yt-dlp and the best thumbnail", () => {
    expect(
      videoFromResult({
        title: "Red panda playtime",
        url: "https://www.youtube.com/watch?v=abc",
        thumbnail: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
        length: "1:23",
      }),
    ).toEqual({
      kind: "video",
      title: "Red panda playtime",
      sourcePageUrl: "https://www.youtube.com/watch?v=abc",
      mediaUrl: "https://www.youtube.com/watch?v=abc",
      thumbnailUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
      durationSeconds: 83,
    });
    expect(videoFromResult({ title: "no url" })).toBeUndefined();
  });

  it("is unavailable without yt-dlp", () => {
    setYtDlpForTests({ available: false });
    const video = listBuiltinTools({ url: "http://searxng", safesearch: 1 }).find(
      (tool) => tool.name === "video_search",
    );
    expect(video).toMatchObject({
      available: false,
      unavailable_reason: "video playback needs yt-dlp, which was not found",
    });
    setYtDlpForTests({ available: true });
    expect(
      listBuiltinTools({ url: "http://searxng", safesearch: 1 }).every((tool) => tool.available),
    ).toBe(true);
  });
});

describe("yt-dlp", () => {
  it("asks for one MP4 with picture and sound at 720p or below, URL after --", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=abc");
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=abc"]);
    expect(args).toContain("--dump-single-json");
    expect(args).toContain("--no-playlist");
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe("node");
    expect(args[args.indexOf("--format") + 1]).toBe(YTDLP_FORMAT);
    expect(YTDLP_FORMAT).toContain("[ext=mp4]");
    expect(YTDLP_FORMAT).toContain("[height<=?720]");
    expect(YTDLP_FORMAT).toContain("[acodec!=?none]");
  });

  it("reads the stream URL and forwards only safe headers", () => {
    const stream = parseYtDlpOutput(
      JSON.stringify({
        url: "https://rr1.googlevideo.com/videoplayback?id=1",
        ext: "mp4",
        height: 360,
        http_headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
          Cookie: "SID=secret",
          "Sec-Fetch-Mode": "navigate",
        },
      }),
    );
    expect(stream).toEqual({
      url: "https://rr1.googlevideo.com/videoplayback?id=1",
      mimeType: "video/mp4",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    });
    expect(parseYtDlpOutput(JSON.stringify({ url: "https://x/v", ext: "webm" })).mimeType).toBe(
      "video/webm",
    );
    expect(
      parseYtDlpOutput(JSON.stringify({ url: "https://x/v", available_at: 1795499280 }))
        .availableAt,
    ).toBe(1795499280000);
  });

  it("rejects output without a direct URL", () => {
    expect(() => parseYtDlpOutput("not json")).toThrow("could not be read");
    expect(() =>
      parseYtDlpOutput(JSON.stringify({ requested_formats: [{}, {}], ext: "mp4" })),
    ).toThrow("no direct MP4");
  });

  it("turns yt-dlp errors into short messages", () => {
    expect(
      ytDlpErrorMessage(
        "WARNING: x\nERROR: [youtube] abc123: Sign in to confirm your age. This video may be inappropriate for some users.\n",
      ),
    ).toBe("Sign in to confirm your age. This video may be inappropriate for some users.");
    expect(ytDlpErrorMessage("ERROR: [vimeo] 1: Requested format is not available")).toBe(
      "This video has no MP4 with picture and sound at 720p or below.",
    );
    expect(ytDlpErrorMessage("ERROR: Unsupported URL: https://example.com/")).toBe(
      "This video site is not supported.",
    );
    expect(ytDlpErrorMessage("")).toBe("The video could not be resolved.");
  });
});
