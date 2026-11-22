import { describe, expect, it } from "vitest";
import {
  cameraInputSchema,
  cameraUpdateSchema,
  httpUrlSchema,
  normalizeTags,
  tagsSchema,
} from "@/lib/media-schemas";
import { mediaContentUrl, resolvePublicBaseUrl } from "@/server/media/public-url";
import { parseRange } from "@/server/media/range";
import { sniffAllowedMimeType } from "@/server/media/sniff";
import {
  baseMimeType,
  findMediaType,
  IMAGE_MAX_BYTES,
  MEGABYTE,
  sizeError,
  VIDEO_MAX_BYTES,
} from "@/server/media/types";
import { maskUsername } from "@/server/services/cameras";
import { makeGif, makeJpeg, makeMp4, makePng, makeWebm } from "../support/media-files";

describe("mime sniffing", () => {
  it.each([
    ["png", makePng(2, 2, [1, 2, 3]), "image/png"],
    ["jpeg", makeJpeg(), "image/jpeg"],
    ["gif", makeGif(), "image/gif"],
    ["mp4", makeMp4(), "video/mp4"],
    ["webm", makeWebm(), "video/webm"],
  ])("identifies %s from its magic bytes", async (_name, bytes, mime) => {
    expect(await sniffAllowedMimeType(bytes)).toBe(mime);
  });

  it("rejects text, HTML and scripts that merely carry an image name", async () => {
    expect(await sniffAllowedMimeType(Buffer.from("<html><script>alert(1)</script></html>"))).toBe(
      undefined,
    );
    expect(await sniffAllowedMimeType(Buffer.from("just some plain text"))).toBe(undefined);
    expect(await sniffAllowedMimeType(Buffer.alloc(0))).toBe(undefined);
  });

  it("rejects recognised but disallowed types such as PDF", async () => {
    expect(await sniffAllowedMimeType(Buffer.from("%PDF-1.7\n%âãÏÓ\n"))).toBe(undefined);
  });
});

describe("media limits", () => {
  it("allows exactly png, jpeg, gif, webp, mp4 and webm", () => {
    for (const mime of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/webm",
    ]) {
      expect(findMediaType(mime)).toBeDefined();
    }
    expect(findMediaType("image/svg+xml")).toBeUndefined();
    expect(findMediaType("video/quicktime")).toBeUndefined();
    expect(findMediaType("constructor")).toBeUndefined();
  });

  it("limits images to 20 MB and videos to 200 MB", () => {
    expect(IMAGE_MAX_BYTES).toBe(20 * MEGABYTE);
    expect(VIDEO_MAX_BYTES).toBe(200 * MEGABYTE);
    expect(sizeError("image/png", 20 * MEGABYTE)).toBeUndefined();
    expect(sizeError("image/png", 20 * MEGABYTE + 1)).toMatch(/at most 20 MB/);
    expect(sizeError("video/mp4", 200 * MEGABYTE)).toBeUndefined();
    expect(sizeError("video/webm", 200 * MEGABYTE + 1)).toMatch(/at most 200 MB/);
    expect(sizeError("text/html", 10)).toMatch(/Unsupported/);
  });

  it("strips parameters and case from content types", () => {
    expect(baseMimeType("Image/PNG; charset=binary")).toBe("image/png");
    expect(baseMimeType(null)).toBe("");
  });
});

describe("range parsing", () => {
  const size = 1000;

  it("serves the whole file without a Range header", () => {
    expect(parseRange(null, size)).toEqual({ kind: "full" });
    expect(parseRange("", size)).toEqual({ kind: "full" });
  });

  it("parses bytes=a-b, bytes=a- and bytes=-n", () => {
    expect(parseRange("bytes=0-99", size)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(parseRange("bytes=900-", size)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(parseRange("bytes=-100", size)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(parseRange("bytes=-5000", size)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("clamps an end past the file to the last byte", () => {
    expect(parseRange("bytes=500-5000", size)).toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("answers 416 for ranges that cannot be satisfied", () => {
    expect(parseRange("bytes=1000-", size)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=2000-3000", size)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", size)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=9-2", size)).toEqual({ kind: "unsatisfiable" });
  });

  it("serves the whole file for malformed, unknown-unit and multiple ranges", () => {
    for (const header of ["bytes=abc", "bytes=-", "items=0-5", "bytes=0-1,5-9", "garbage"]) {
      expect(parseRange(header, size)).toEqual({ kind: "full" });
    }
  });
});

describe("public URLs", () => {
  const request = "http://internal:3000/v1/media";

  it("prefers PUBLIC_BASE_URL and trims trailing slashes", () => {
    expect(resolvePublicBaseUrl(request, new Headers(), "https://gw.example.com/")).toBe(
      "https://gw.example.com",
    );
  });

  it("falls back to forwarded headers, then the request origin", () => {
    const forwarded = new Headers({
      "x-forwarded-host": "gw.example.com",
      "x-forwarded-proto": "https",
    });
    expect(resolvePublicBaseUrl(request, forwarded, undefined)).toBe("https://gw.example.com");
    expect(resolvePublicBaseUrl(request, new Headers(), undefined)).toBe("http://internal:3000");
  });

  it("builds an absolute content URL", () => {
    expect(mediaContentUrl("https://gw.example.com", "med_abc123")).toBe(
      "https://gw.example.com/v1/media/med_abc123/content",
    );
  });
});

describe("tags and URLs", () => {
  it("normalises tags: lowercase, trimmed, dashes for spaces, unique", () => {
    expect(normalizeTags([" Nature ", "nature", "Sun set", ""])).toEqual(["nature", "sun-set"]);
    expect(tagsSchema.parse(["A", "a", "B"])).toEqual(["a", "b"]);
    expect(tagsSchema.safeParse(["a,b"]).success).toBe(false);
    expect(tagsSchema.safeParse(["x".repeat(33)]).success).toBe(false);
  });

  it("accepts http(s) URLs only and rejects embedded credentials", () => {
    expect(httpUrlSchema.safeParse("https://example.com/a.png").success).toBe(true);
    expect(httpUrlSchema.safeParse("ftp://example.com/a.png").success).toBe(false);
    expect(httpUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(httpUrlSchema.safeParse("http://user:pw@example.com/stream").success).toBe(false);
  });
});

describe("camera schema", () => {
  it("accepts lookat_sidecar without an address", () => {
    const parsed = cameraInputSchema.parse({ type: "lookat_sidecar", name: "Look-at" });
    expect(parsed).toEqual({
      type: "lookat_sidecar",
      name: "Look-at",
      description: "",
      enabled: true,
    });
  });

  it("requires a URL for mjpeg_url and accepts optional credentials", () => {
    expect(cameraInputSchema.safeParse({ type: "mjpeg_url", name: "Lobby" }).success).toBe(false);
    const parsed = cameraInputSchema.parse({
      type: "mjpeg_url",
      name: "Lobby",
      url: "http://cam.local/stream.mjpg",
      credentials: { username: "viewer", password: "pw" },
    });
    expect(parsed).toMatchObject({ url: "http://cam.local/stream.mjpg" });
  });

  it("rejects unknown and reserved types on write", () => {
    expect(cameraInputSchema.safeParse({ type: "rtsp_via_relay", name: "Door" }).success).toBe(
      false,
    );
    expect(cameraInputSchema.safeParse({ type: "hologram", name: "X" }).success).toBe(false);
  });

  it("treats credentials as absent, null (clear) or a complete pair", () => {
    expect(cameraUpdateSchema.parse({}).credentials).toBeUndefined();
    expect(cameraUpdateSchema.parse({ credentials: null }).credentials).toBeNull();
    expect(cameraUpdateSchema.safeParse({ credentials: { username: "a" } }).success).toBe(false);
  });

  it("masks usernames without revealing short ones", () => {
    expect(maskUsername("viewer")).toBe("v••••r");
    expect(maskUsername("ab")).toBe("••");
  });
});
