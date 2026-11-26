import { describe, expect, it } from "vitest";
import {
  describeWebMedia,
  formatDuration,
  guessImageType,
  isWebMediaId,
  newWebMediaId,
  toWebMediaEntry,
  type WebMediaRow,
} from "@/server/services/web-media";
import { imageFromResult } from "@/server/tools/builtin/media-search";

function row(overrides: Partial<WebMediaRow> = {}): WebMediaRow {
  return {
    id: "wm_0123456789abcdef",
    sessionId: "00000000-0000-4000-8000-000000000000",
    apiKeyId: "00000000-0000-4000-8000-000000000001",
    kind: "image",
    title: "Red panda",
    sourcePageUrl: "https://www.example.org/pandas",
    mediaUrl: "https://cdn.example.org/panda.webp",
    thumbnailUrl: null,
    resolution: "1024 x 768",
    durationSeconds: null,
    resolvedUrl: null,
    resolvedMimeType: null,
    resolvedHeaders: null,
    resolvedAt: null,
    resolveError: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

describe("temporary web media", () => {
  it("issues unguessable wm_ ids", () => {
    const id = newWebMediaId();
    expect(isWebMediaId(id)).toBe(true);
    expect(newWebMediaId()).not.toBe(id);
    expect(isWebMediaId("med_0123456789ab")).toBe(false);
    expect(isWebMediaId("wm_../../etc")).toBe(false);
  });

  it("describes items for the model", () => {
    expect(describeWebMedia(row())).toBe("Web image from example.org, 1024×768.");
    expect(
      describeWebMedia(
        row({ kind: "video", resolution: null, durationSeconds: 3725, sourcePageUrl: null }),
      ),
    ).toBe("Web video from cdn.example.org, 1:02:05.");
    expect(formatDuration(83)).toBe("1:23");
  });

  it("maps to the /v1/media entry shape with a gateway content URL", () => {
    expect(toWebMediaEntry(row(), "https://gw.example.com")).toEqual({
      id: "wm_0123456789abcdef",
      name: "Red panda",
      description: "Web image from example.org, 1024×768.",
      kind: "image",
      tags: ["web"],
      content_url: "https://gw.example.com/v1/media/wm_0123456789abcdef/content",
      mime_type: "image/webp",
    });
    expect(toWebMediaEntry(row({ kind: "video", title: "" }), "https://gw").mime_type).toBe(
      "video/mp4",
    );
    expect(guessImageType("https://x.example/photo")).toBe("image/jpeg");
  });

  it("keeps only image results with an http image URL", () => {
    expect(imageFromResult({ title: "x", img_src: "data:image/png;base64,AA" })).toBeUndefined();
    expect(
      imageFromResult({
        title: "  A   panda ",
        url: "https://page.example/",
        img_src: "https://img.example/a.jpg",
        thumbnail_src: "https://thumb.example/a.jpg",
        resolution: "800 × 600",
      }),
    ).toEqual({
      kind: "image",
      title: "A panda",
      sourcePageUrl: "https://page.example/",
      mediaUrl: "https://img.example/a.jpg",
      thumbnailUrl: "https://thumb.example/a.jpg",
      resolution: "800 × 600",
    });
  });
});
