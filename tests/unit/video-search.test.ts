import { afterEach, describe, expect, it } from "vitest";
import { parseDuration, videoFromResult } from "@/server/tools/builtin/media-search";
import { listBuiltinTools } from "@/server/tools/builtin/registry";
import {
  buildYtDlpArgs,
  parseYtDlpOutput,
  setYtDlpForTests,
  YTDLP_FORMAT,
  youtubeVideoId,
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

  it.each([
    ["https://www.youtube.com/watch?v=Da_SK3INxvw&t=4", "Da_SK3INxvw"],
    ["https://m.youtube.com/watch?v=Da_SK3INxvw", "Da_SK3INxvw"],
    ["https://youtu.be/Da_SK3INxvw?si=x", "Da_SK3INxvw"],
    ["https://www.youtube.com/shorts/Da_SK3INxvw", "Da_SK3INxvw"],
    ["https://www.youtube-nocookie.com/embed/Da_SK3INxvw", "Da_SK3INxvw"],
    ["https://www.youtube.com/watch?v=short", undefined],
    ["https://www.youtube.com/@channel", undefined],
    ["https://evil.example/watch?v=Da_SK3INxvw", undefined],
    ["https://youtube.com.evil.example/watch?v=Da_SK3INxvw", undefined],
    ["https://vimeo.com/383815620", undefined],
    [undefined, undefined],
  ])("reads the YouTube id of %s", (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it("keeps YouTube results only, as a canonical watch URL", () => {
    expect(
      videoFromResult({
        title: "Red panda playtime - YouTube",
        url: "https://youtu.be/Da_SK3INxvw",
        thumbnail: "https://i.ytimg.com/vi/Da_SK3INxvw/hqdefault.jpg",
        length: "1:23",
      }),
    ).toEqual({
      kind: "video",
      title: "Red panda playtime",
      sourcePageUrl: "https://www.youtube.com/watch?v=Da_SK3INxvw",
      mediaUrl: "https://www.youtube.com/watch?v=Da_SK3INxvw",
      thumbnailUrl: "https://i.ytimg.com/vi/Da_SK3INxvw/hqdefault.jpg",
      durationSeconds: 83,
    });
    expect(
      videoFromResult({
        title: "Found on Bing",
        url: "https://www.bing.com/videos/x",
        iframe_src: "https://www.youtube-nocookie.com/embed/Da_SK3INxvw",
      })?.mediaUrl,
    ).toBe("https://www.youtube.com/watch?v=Da_SK3INxvw");
    expect(videoFromResult({ title: "Vimeo", url: "https://vimeo.com/1" })).toBeUndefined();
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
