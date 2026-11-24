import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { mediaItems, sessions, webMediaItems } from "@/server/db/schema";
import { resetEnvCacheForTests } from "@/server/env";
import { setTestAllowedAddresses } from "@/server/net/public-fetch";
import { expireIdleSessions } from "@/server/services/session-maintenance";
import { endSession } from "@/server/services/sessions";
import { createWebMediaItems, type NewWebMedia } from "@/server/services/web-media";
import { setYtDlpForTests, type YtDlpRunner } from "@/server/tools/builtin/video-resolver";
import { type MockSearxng, startMockSearxng } from "../support/mock-searxng";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import { type MockWebMedia, startMockWebMedia } from "../support/mock-web-media";
import {
  prepareDatabase,
  resetGatewayState,
  seedApiKey,
  seedProvider,
  seedRoute,
  waitFor,
} from "./support";

const databaseUrl = inject("databaseUrl");

interface SearchResult {
  media_id: string;
  title: string;
  description: string;
  source_page: string;
  resolution?: string;
}

describe("temporary web media: image_search, look-up and streaming proxy", () => {
  const app = createApiApp();
  let upstream: MockUpstream;
  let searxng: MockSearxng;
  let media: MockWebMedia;
  let key: string;
  let keyId: string;
  const ytDlpCalls: string[][] = [];

  /** Fake yt-dlp: /watch/red-panda resolves to the mock /clip.mp4; other pages fail like yt-dlp. */
  const fakeYtDlp: YtDlpRunner = async (args) => {
    ytDlpCalls.push(args);
    const page = args.at(-1) ?? "";
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (page.endsWith("/watch/red-panda")) {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          url: `${media.url}/clip.mp4`,
          ext: "mp4",
          http_headers: { "User-Agent": "yt-dlp-test", Cookie: "never" },
        }),
      };
    }
    if (page.endsWith("/watch/delayed")) {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          url: `${media.url}/clip.mp4`,
          ext: "mp4",
          available_at: Math.floor(Date.now() / 1000) + 1,
        }),
      };
    }
    if (page.endsWith("/watch/expired")) {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ url: `${media.url}/expired.mp4`, ext: "mp4" }),
      };
    }
    return { code: 1, stdout: "", stderr: "ERROR: [vimeo] 1: Requested format is not available" };
  };

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream();
    media = await startMockWebMedia();
    searxng = await startMockSearxng({ mediaBaseUrl: media.url });
    process.env.SEARXNG_URL = searxng.url;
    resetEnvCacheForTests();
  });

  afterAll(async () => {
    delete process.env.SEARXNG_URL;
    resetEnvCacheForTests();
    setTestAllowedAddresses([]);
    setYtDlpForTests(undefined);
    await resetGatewayState();
    await upstream.close();
    await searxng.close();
    await media.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    setTestAllowedAddresses(["127.0.0.1"]);
    await resetGatewayState();
    const provider = await seedProvider("Mock", upstream.url);
    const created = await seedApiKey();
    key = created.key;
    keyId = created.apiKey.id;
    await seedRoute(
      "search-route",
      [{ providerId: provider.id, model: "gateway-tool" }],
      true,
      [],
      ["image_search", "video_search"],
    );
    ytDlpCalls.length = 0;
    setYtDlpForTests({ available: true, runner: fakeYtDlp });
  });

  afterEach(() => {
    upstream.reset();
    searxng.reset();
    media.reset();
  });

  function get(path: string, init: RequestInit = {}, apiKey = key) {
    return app.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
    });
  }

  /** Runs a media search through the tool loop; returns the session id and the results. */
  async function imageSearch(
    args: Record<string, unknown> = { query: "red panda" },
    tool = "image_search",
  ) {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "search-route",
        messages: [{ role: "user", content: JSON.stringify({ tool, args }) }],
      }),
    });
    expect(response.status).toBe(200);
    const text = (await response.json()).choices[0].message.content as string;
    const payload = text.slice("Result: ".length);
    return {
      sessionId: response.headers.get("x-session-id") as string,
      payload,
      results: payload.startsWith("{")
        ? ((JSON.parse(payload) as { results: SearchResult[] }).results ?? [])
        : [],
    };
  }

  async function seedItem(sessionId: string, item: Partial<NewWebMedia>) {
    const [row] = await createWebMediaItems(sessionId, keyId, [
      { kind: "image", title: "Seeded", mediaUrl: `${media.url}/red-panda.png`, ...item },
    ]);
    return row;
  }

  it("returns temporary media ids with title, source page and resolution", async () => {
    const { sessionId, results } = await imageSearch();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      media_id: expect.stringMatching(/^wm_[0-9a-f]{16}$/),
      title: "Red panda in a tree",
      description: "Web image from commons.wikimedia.org, 1024×768.",
      source_page: "https://commons.wikimedia.org/wiki/File:Red_panda.jpg",
      resolution: "1024 × 768",
    });
    expect(searxng.searches[0]).toMatchObject({ categories: "images", safesearch: "1" });
    const rows = await getDb()
      .select()
      .from(webMediaItems)
      .where(eq(webMediaItems.sessionId, sessionId));
    expect(rows.map((row) => row.apiKeyId)).toEqual([keyId, keyId]);
  });

  it("looks up temporary and catalogue items in the /v1/media shape", async () => {
    const { results } = await imageSearch();
    const response = await get(`/v1/media/${results[0].media_id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: results[0].media_id,
      name: "Red panda in a tree",
      description: "Web image from commons.wikimedia.org, 1024×768.",
      kind: "image",
      tags: ["web"],
      content_url: `http://localhost/v1/media/${results[0].media_id}/content`,
      mime_type: "image/png",
    });

    await getDb()
      .insert(mediaItems)
      .values([
        {
          id: "med_aaaaaaaaaaaa",
          name: "Lobby",
          kind: "image",
          source: "external_url",
          externalUrl: "https://cdn.example.com/lobby.png",
          mimeType: "image/png",
        },
        {
          id: "med_bbbbbbbbbbbb",
          name: "Hidden",
          kind: "image",
          source: "external_url",
          externalUrl: "https://cdn.example.com/hidden.png",
          mimeType: "image/png",
          enabled: false,
        },
      ]);
    const catalogue = await get("/v1/media/med_aaaaaaaaaaaa");
    expect(await catalogue.json()).toMatchObject({
      id: "med_aaaaaaaaaaaa",
      content_url: "https://cdn.example.com/lobby.png",
    });
    const disabled = await get("/v1/media/med_bbbbbbbbbbbb");
    expect(disabled.status).toBe(404);
    expect((await disabled.json()).error.code).toBe("media_not_found");
    expect((await get("/v1/media/wm_0000000000000000")).status).toBe(404);
  });

  it("streams the image through with Range forwarded and the source page as referer", async () => {
    const { results } = await imageSearch();
    const id = results[0].media_id;

    const full = await get(`/v1/media/${id}/content`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/png");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(media.png);
    expect(media.requests[0]).toMatchObject({
      path: "/red-panda.png",
      referer: "https://commons.wikimedia.org/wiki/File:Red_panda.jpg",
    });

    const partial = await get(`/v1/media/${id}/content`, { headers: { Range: "bytes=0-9" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${media.png.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(media.png.subarray(0, 10));
    expect(media.requests.at(-1)?.range).toBe("bytes=0-9");

    const head = await get(`/v1/media/${id}/content`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("content-length")).toBe(String(media.png.length));
    expect(await head.text()).toBe("");
  });

  it("falls back to the thumbnail and keeps serving the same bytes", async () => {
    const { results } = await imageSearch();
    const id = results[1].media_id; // img_src is /missing.png
    const first = await get(`/v1/media/${id}/content`);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(media.thumb);
    media.reset();
    const again = await get(`/v1/media/${id}/content`, { headers: { Range: "bytes=0-3" } });
    expect(again.status).toBe(206);
    expect(media.requests.map((request) => request.path)).toEqual(["/red-panda-thumb.png"]);
  });

  it("answers 502 media_unavailable when no candidate is usable", async () => {
    const { sessionId } = await imageSearch();
    const svg = await seedItem(sessionId, { mediaUrl: `${media.url}/vector.svg` });
    const huge = await seedItem(sessionId, { mediaUrl: `${media.url}/huge.png` });
    const privateHost = await seedItem(sessionId, { mediaUrl: "http://10.255.255.1/a.png" });
    for (const row of [svg, huge]) {
      const response = await get(`/v1/media/${row.id}/content`);
      expect(response.status).toBe(502);
      expect((await response.json()).error).toMatchObject({
        code: "media_unavailable",
        message: "The image is not a PNG, JPEG, GIF or WebP file under 20 MB.",
      });
    }
    const blocked = await get(`/v1/media/${privateHost.id}/content`);
    expect(blocked.status).toBe(502);
    expect((await blocked.json()).error.message).toBe(
      "Private network addresses cannot be opened.",
    );
  });

  it("hides items from other API keys", async () => {
    const { results } = await imageSearch();
    const other = await seedApiKey();
    const id = results[0].media_id;
    for (const path of [`/v1/media/${id}`, `/v1/media/${id}/content`]) {
      const response = await get(path, {}, other.key);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("media_not_found");
    }
  });

  it("deletes items when the client ends the session", async () => {
    const { sessionId, results } = await imageSearch();
    const ended = await get(`/v1/sessions/${sessionId}/end`, { method: "POST" });
    expect(ended.status).toBe(204);
    expect((await get(`/v1/media/${results[0].media_id}`)).status).toBe(404);
    expect(await getDb().select().from(webMediaItems)).toHaveLength(0);
  });

  it("deletes items when an admin ends the session or it expires", async () => {
    const first = await imageSearch();
    await endSession(first.sessionId);
    const second = await imageSearch();
    // Transcript persistence runs after the response and refreshes the activity time.
    await waitFor(async () => {
      const [row] = await getDb().select().from(sessions).where(eq(sessions.id, second.sessionId));
      return row && row.turnCount > 0 ? row : undefined;
    });
    await getDb()
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - 24 * 3_600_000) })
      .where(eq(sessions.id, second.sessionId));
    expect(await expireIdleSessions()).toBe(1);
    expect(await getDb().select().from(webMediaItems)).toHaveLength(0);
  });

  it("counts streaming as session activity", async () => {
    const { sessionId, results } = await imageSearch();
    await waitFor(async () => {
      const [row] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
      return row && row.turnCount > 0 ? row : undefined;
    });
    const stale = new Date(Date.now() - 10 * 60_000);
    await getDb().update(sessions).set({ lastActivityAt: stale }).where(eq(sessions.id, sessionId));
    await (await get(`/v1/media/${results[0].media_id}/content`)).arrayBuffer();
    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime() + 60_000);
  });

  describe("video_search", () => {
    const videoSearch = () => imageSearch({ query: "red panda" }, "video_search");

    it("returns temporary video ids with length and source page", async () => {
      const { results } = await videoSearch();
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        media_id: expect.stringMatching(/^wm_/),
        title: "Red panda playtime",
        description: "Web video from 127.0.0.1, 1:23.",
        source_page: `${media.url}/watch/red-panda`,
        duration_seconds: 83,
      });
      expect(searxng.searches[0].categories).toBe("videos");
      expect(ytDlpCalls).toHaveLength(0); // resolved lazily, not at search time
      const entry = await (await get(`/v1/media/${results[0].media_id}`)).json();
      expect(entry).toMatchObject({ kind: "video", mime_type: "video/mp4", tags: ["web"] });
    });

    it("resolves once on first playback, caches it, and streams with Range", async () => {
      const { results } = await videoSearch();
      const path = `/v1/media/${results[0].media_id}/content`;
      const [head, full] = await Promise.all([get(path, { method: "HEAD" }), get(path)]);
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("video/mp4");
      expect(full.status).toBe(200);
      expect(Buffer.from(await full.arrayBuffer())).toEqual(media.mp4);
      expect(ytDlpCalls).toHaveLength(1);
      expect(ytDlpCalls[0].slice(-2)).toEqual(["--", `${media.url}/watch/red-panda`]);
      // yt-dlp's headers are forwarded upstream, cookies never.
      const upstreamCall = media.requests.find((request) => request.path === "/clip.mp4");
      expect(upstreamCall?.userAgent).toBe("yt-dlp-test");

      const partial = await get(path, { headers: { Range: "bytes=100-199" } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(`bytes 100-199/${media.mp4.length}`);
      expect(partial.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await partial.arrayBuffer())).toEqual(media.mp4.subarray(100, 200));
      expect(ytDlpCalls).toHaveLength(1);
    });

    it("surfaces unplayable videos as errors and does not retry", async () => {
      const { results } = await videoSearch();
      const path = `/v1/media/${results[1].media_id}/content`; // vimeo page: no format
      const first = await get(path);
      expect(first.status).toBe(502);
      expect((await first.json()).error).toEqual({
        message: "This video has no MP4 with picture and sound at 720p or below.",
        type: "api_error",
        code: "media_unavailable",
      });
      expect((await get(path)).status).toBe(502);
      expect(ytDlpCalls).toHaveLength(1);
    });

    it("waits for a link that is not valid yet, without holding up a probe", async () => {
      const { sessionId } = await videoSearch();
      const [row] = await createWebMediaItems(sessionId, keyId, [
        { kind: "video", title: "With ad", mediaUrl: `${media.url}/watch/delayed` },
      ]);
      const path = `/v1/media/${row.id}/content`;
      const head = await get(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("video/mp4");
      expect(media.requests.filter((request) => request.path === "/clip.mp4")).toHaveLength(0);
      const started = Date.now();
      const full = await get(path);
      expect(full.status).toBe(200);
      expect(Buffer.from(await full.arrayBuffer())).toEqual(media.mp4);
      // available_at has one-second resolution, plus the proxy's one-second margin.
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect(ytDlpCalls).toHaveLength(1);
    });

    it("fails playback when the resolved link expired", async () => {
      const { sessionId } = await videoSearch();
      const [row] = await createWebMediaItems(sessionId, keyId, [
        { kind: "video", title: "Old", mediaUrl: `${media.url}/watch/expired` },
      ]);
      const response = await get(`/v1/media/${row.id}/content`);
      expect(response.status).toBe(502);
      expect((await response.json()).error.message).toBe(
        "The video source answered HTTP 403; the link may have expired.",
      );
    });

    it("never runs yt-dlp for private pages", async () => {
      const { sessionId } = await videoSearch();
      const [row] = await createWebMediaItems(sessionId, keyId, [
        { kind: "video", title: "Internal", mediaUrl: "http://192.168.1.10/watch/red-panda" },
      ]);
      const response = await get(`/v1/media/${row.id}/content`);
      expect(response.status).toBe(502);
      expect((await response.json()).error.message).toBe(
        "Private network addresses cannot be opened.",
      );
      expect(ytDlpCalls).toHaveLength(0);
    });

    it("is not offered when yt-dlp is missing", async () => {
      setYtDlpForTests({ available: false });
      await videoSearch().catch(() => undefined);
      const offered = upstream.chatRequests()[0].body?.tools as { function: { name: string } }[];
      expect(offered.map((tool) => tool.function.name)).toEqual(["image_search"]);
    });
  });

  it("reports when nothing usable was found", async () => {
    searxng.setResults("images", [{ title: "No image", url: "https://example.org/" }]);
    const { payload } = await imageSearch();
    expect(payload).toBe("No results found.");
  });
});
