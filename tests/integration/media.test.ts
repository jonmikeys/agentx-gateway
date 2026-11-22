import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAdminApp } from "@/server/api/admin-app";
import { createApiApp } from "@/server/api/app";
import { closeDatabase } from "@/server/db/client";
import { resetEnvCacheForTests } from "@/server/env";
import { inspectExternalMedia } from "@/server/media/external";
import { setMediaStorageForTests } from "@/server/media/storage";
import { makeGif, makeMp4, makePng } from "../support/media-files";
import { type MockMediaServer, startMockMediaServer } from "../support/mock-media-server";
import { adminHeaders, prepareDatabase, resetGatewayState, seedApiKey } from "./support";

const databaseUrl = inject("databaseUrl");
const MEGABYTE = 1024 * 1024;

describe("media API", () => {
  const admin = createAdminApp();
  const api = createApiApp();
  let storageDir: string;
  let remote: MockMediaServer;
  let key: string;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    storageDir = await mkdtemp(path.join(tmpdir(), "agx-media-"));
    process.env.MEDIA_STORAGE_DIR = storageDir;
    delete process.env.PUBLIC_BASE_URL;
    resetEnvCacheForTests();
    setMediaStorageForTests(undefined);
    remote = await startMockMediaServer();
  });

  afterAll(async () => {
    await remote.close();
    await closeDatabase();
    setMediaStorageForTests(undefined);
    delete process.env.MEDIA_STORAGE_DIR;
    resetEnvCacheForTests();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetGatewayState();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.PUBLIC_BASE_URL;
    resetEnvCacheForTests();
    key = (await seedApiKey()).key;
  });

  const authorization = () => ({ Authorization: `Bearer ${key}` });

  const adminCall = (url: string, method = "GET", body?: unknown) =>
    admin.request(`/api/admin/${url}`, {
      method,
      headers: adminHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function upload(
    bytes: Buffer,
    fields: Record<string, string> = {},
    filename = "file.png",
    declaredType = "image/png",
  ) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: declaredType }), filename);
    return admin.request("/api/admin/media/upload", {
      method: "POST",
      headers: { Authorization: adminHeaders().Authorization },
      body: form,
    });
  }

  async function uploadPng(fields: Record<string, string> = {}) {
    const response = await upload(makePng(4, 3, [200, 30, 30]), { name: "Red", ...fields });
    expect(response.status).toBe(201);
    return response.json();
  }

  const clientGet = (url: string, headers: Record<string, string> = {}) =>
    api.request(url, { headers: { ...authorization(), ...headers } });

  describe("uploads", () => {
    it("stores a PNG, sniffs its type, reads its size and lists it", async () => {
      const item = await uploadPng({ description: "A red square", tags: "Color, red" });
      expect(item).toMatchObject({
        name: "Red",
        description: "A red square",
        kind: "image",
        mime_type: "image/png",
        source: "upload",
        width: 4,
        height: 3,
        tags: ["color", "red"],
        enabled: true,
      });
      expect(item.id).toMatch(/^med_[0-9a-f]{12}$/);
      expect(item.size_bytes).toBeGreaterThan(0);
      expect(await readdir(storageDir)).toEqual([`${item.id}.png`]);
    });

    it("uses the file name as the default name", async () => {
      const response = await upload(makeGif(), {}, "party.gif", "image/gif");
      expect(response.status).toBe(201);
      expect((await response.json()).name).toBe("party");
    });

    it("accepts an MP4 and classifies it as a video", async () => {
      const response = await upload(makeMp4(2000), { name: "Clip" }, "clip.mp4", "video/mp4");
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ kind: "video", mime_type: "video/mp4" });
    });

    it("rejects a file whose bytes are not an allowed type, whatever it claims", async () => {
      const response = await upload(Buffer.from("<html><script>1</script></html>"), {}, "evil.png");
      expect(response.status).toBe(415);
      expect((await response.json()).error.code).toBe("unsupported_media_type");
      expect(existsSync(storageDir) ? await readdir(storageDir) : []).toEqual([]);
    });

    it("rejects an image over 20 MB without leaving a partial file", async () => {
      const big = Buffer.concat([makePng(2, 2, [0, 0, 0]), Buffer.alloc(21 * MEGABYTE)]);
      const response = await upload(big, { name: "Big" });
      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("media_too_large");
      expect(existsSync(storageDir) ? await readdir(storageDir) : []).toEqual([]);
      expect((await (await adminCall("media")).json()).data).toEqual([]);
    });

    it("rejects an empty file, a missing file part and a non-multipart body", async () => {
      expect((await upload(Buffer.alloc(0))).status).toBe(400);

      const noFile = new FormData();
      noFile.append("name", "No file");
      const missing = await admin.request("/api/admin/media/upload", {
        method: "POST",
        headers: { Authorization: adminHeaders().Authorization },
        body: noFile,
      });
      expect(missing.status).toBe(400);

      const json = await admin.request("/api/admin/media/upload", {
        method: "POST",
        headers: adminHeaders(),
        body: "{}",
      });
      expect(json.status).toBe(400);
    });

    it("rejects invalid tags and removes the stored file", async () => {
      const response = await upload(makePng(2, 2, [9, 9, 9]), {
        name: "Tagged",
        tags: JSON.stringify(["x".repeat(40)]),
      });
      expect(response.status).toBe(400);
      expect(existsSync(storageDir) ? await readdir(storageDir) : []).toEqual([]);
    });

    it("requires admin authentication", async () => {
      const response = await admin.request("/api/admin/media/upload", { method: "POST" });
      expect(response.status).toBe(401);
    });
  });

  describe("catalogue", () => {
    it("lists enabled items only, with absolute content URLs", async () => {
      const shown = await uploadPng({ name: "Shown", tags: "demo" });
      const hidden = await uploadPng({ name: "Hidden", enabled: "false" });
      const response = await clientGet("/v1/media");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.object).toBe("list");
      expect(body.data).toEqual([
        {
          id: shown.id,
          name: "Shown",
          description: "",
          kind: "image",
          tags: ["demo"],
          content_url: `http://localhost/v1/media/${shown.id}/content`,
          mime_type: "image/png",
        },
      ]);
      expect(JSON.stringify(body)).not.toContain(hidden.id);
    });

    it("builds content URLs from PUBLIC_BASE_URL when set", async () => {
      const item = await uploadPng();
      process.env.PUBLIC_BASE_URL = "https://gateway.example.com/";
      resetEnvCacheForTests();
      const body = await (await clientGet("/v1/media")).json();
      expect(body.data[0].content_url).toBe(
        `https://gateway.example.com/v1/media/${item.id}/content`,
      );
    });

    it("uses forwarded headers when PUBLIC_BASE_URL is unset", async () => {
      const item = await uploadPng();
      const body = await (
        await clientGet("/v1/media", {
          "X-Forwarded-Host": "gw.example.org",
          "X-Forwarded-Proto": "https",
        })
      ).json();
      expect(body.data[0].content_url).toBe(`https://gw.example.org/v1/media/${item.id}/content`);
    });

    it("requires a Bearer key on every /v1 media and camera route", async () => {
      const item = await uploadPng();
      for (const path of ["/v1/media", `/v1/media/${item.id}/content`, "/v1/cameras"]) {
        const response = await api.request(path);
        expect(response.status, path).toBe(401);
        expect((await response.json()).error.code).toBe("invalid_api_key");
      }
    });
  });

  describe("content", () => {
    it("streams the file with Accept-Ranges, ETag and Cache-Control", async () => {
      const bytes = makePng(4, 3, [200, 30, 30]);
      const item = await uploadPng();
      const response = await clientGet(`/v1/media/${item.id}/content`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(response.headers.get("cache-control")).toContain("max-age");
      expect(response.headers.get("etag")).toMatch(/^".+"$/);
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it("answers 206 with Content-Range for a single range", async () => {
      const bytes = makePng(4, 3, [200, 30, 30]);
      const item = await uploadPng();
      const first = await clientGet(`/v1/media/${item.id}/content`, { Range: "bytes=2-9" });
      expect(first.status).toBe(206);
      expect(first.headers.get("content-range")).toBe(`bytes 2-9/${bytes.length}`);
      expect(first.headers.get("content-length")).toBe("8");
      expect(Buffer.from(await first.arrayBuffer()).equals(bytes.subarray(2, 10))).toBe(true);

      const suffix = await clientGet(`/v1/media/${item.id}/content`, { Range: "bytes=-5" });
      expect(suffix.status).toBe(206);
      expect(Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(-5))).toBe(true);

      const open = await clientGet(`/v1/media/${item.id}/content`, {
        Range: `bytes=${bytes.length - 3}-`,
      });
      expect(open.status).toBe(206);
      expect(Buffer.from(await open.arrayBuffer()).equals(bytes.subarray(-3))).toBe(true);
    });

    it("answers 416 with Content-Range */size for an unsatisfiable range", async () => {
      const bytes = makePng(4, 3, [200, 30, 30]);
      const item = await uploadPng();
      const response = await clientGet(`/v1/media/${item.id}/content`, {
        Range: `bytes=${bytes.length}-`,
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    });

    it("serves the whole file for multiple ranges and honours If-None-Match and If-Range", async () => {
      const bytes = makePng(4, 3, [200, 30, 30]);
      const item = await uploadPng();
      const multi = await clientGet(`/v1/media/${item.id}/content`, { Range: "bytes=0-1,4-5" });
      expect(multi.status).toBe(200);
      expect((await multi.arrayBuffer()).byteLength).toBe(bytes.length);

      const etag = (await clientGet(`/v1/media/${item.id}/content`)).headers.get("etag") ?? "";
      const cached = await clientGet(`/v1/media/${item.id}/content`, { "If-None-Match": etag });
      expect(cached.status).toBe(304);
      const stale = await clientGet(`/v1/media/${item.id}/content`, {
        Range: "bytes=0-3",
        "If-Range": '"other"',
      });
      expect(stale.status).toBe(200);
      const fresh = await clientGet(`/v1/media/${item.id}/content`, {
        Range: "bytes=0-3",
        "If-Range": etag,
      });
      expect(fresh.status).toBe(206);
    });

    it("answers HEAD without a body", async () => {
      const item = await uploadPng();
      const response = await api.request(`/v1/media/${item.id}/content`, {
        method: "HEAD",
        headers: authorization(),
      });
      expect(response.status).toBe(200);
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    });

    it("returns 404 media_not_found (never session_not_found) for unknown and disabled ids", async () => {
      const hidden = await uploadPng({ enabled: "false" });
      for (const id of ["med_nope", hidden.id]) {
        const response = await clientGet(`/v1/media/${id}/content`);
        expect(response.status).toBe(404);
        const { error } = await response.json();
        expect(error.code).toBe("media_not_found");
        expect(error.type).toBe("invalid_request_error");
      }
    });

    it("serves previews to the admin, and 401 without credentials", async () => {
      const item = await uploadPng();
      const preview = await adminCall(`media/${item.id}/content`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/png");
      const anonymous = await admin.request(`/api/admin/media/${item.id}/content`);
      expect(anonymous.status).toBe(401);
    });
  });

  describe("external URLs", () => {
    const create = (url: string, extra: Record<string, unknown> = {}) =>
      adminCall("media", "POST", { name: "Remote", external_url: url, ...extra });

    it("accepts an image URL and records its type and size", async () => {
      const response = await create(`${remote.url}/pic.png`, { tags: ["web"] });
      expect(response.status).toBe(201);
      const item = await response.json();
      expect(item).toMatchObject({
        kind: "image",
        mime_type: "image/png",
        source: "external_url",
        external_url: `${remote.url}/pic.png`,
        tags: ["web"],
      });
      expect(item.size_bytes).toBeGreaterThan(0);
    });

    it("accepts a video URL", async () => {
      const response = await create(`${remote.url}/clip.mp4`);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ kind: "video", mime_type: "video/mp4" });
    });

    it("falls back to a ranged GET when the server refuses HEAD", async () => {
      const response = await create(`${remote.url}/no-head.png`);
      expect(response.status).toBe(201);
      expect((await response.json()).size_bytes).toBeGreaterThan(1);
    });

    it("follows up to 3 redirects and refuses more", async () => {
      expect((await create(`${remote.url}/hop/2`)).status).toBe(201);
      const response = await create(`${remote.url}/hop/3`);
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.code).toBe("external_url_unreachable");
      expect(error.message).toMatch(/redirects/);
    });

    it("rejects disallowed content types, oversized files and failing URLs", async () => {
      const html = await create(`${remote.url}/page.html`);
      expect(html.status).toBe(415);
      expect((await html.json()).error.message).toContain("text/html");

      const huge = await create(`${remote.url}/huge.mp4`);
      expect(huge.status).toBe(413);
      expect((await huge.json()).error.code).toBe("media_too_large");

      const missing = await create(`${remote.url}/missing`);
      expect(missing.status).toBe(400);
      expect((await missing.json()).error.message).toContain("404");

      const closedPort = await create("http://127.0.0.1:9/pic.png");
      expect(closedPort.status).toBe(400);

      const notHttp = await create("ftp://example.com/pic.png");
      expect(notHttp.status).toBe(400);
      expect((await notHttp.json()).error.code).toBe("validation_error");
    });

    it("gives up after the timeout", async () => {
      await expect(
        inspectExternalMedia(`${remote.url}/hang`, { timeoutMs: 300 }),
      ).rejects.toMatchObject({ code: "external_url_unreachable" });
    });

    it("lists the external URL itself and redirects content requests to it", async () => {
      const item = await (await create(`${remote.url}/pic.png`)).json();
      const list = await (await clientGet("/v1/media")).json();
      expect(list.data[0].content_url).toBe(`${remote.url}/pic.png`);
      const response = await clientGet(`/v1/media/${item.id}/content`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${remote.url}/pic.png`);
    });
  });

  describe("admin management", () => {
    it("filters by kind, tag, search text and enabled", async () => {
      const sunset = await uploadPng({ name: "Sunset", description: "Orange sky", tags: "nature" });
      const logo = await uploadPng({ name: "Logo", tags: "brand", enabled: "false" });
      await adminCall("media", "POST", {
        name: "Promo",
        external_url: `${remote.url}/clip.mp4`,
        tags: ["brand"],
      });
      const ids = async (query: string) =>
        ((await (await adminCall(`media${query}`)).json()).data as { id: string; name: string }[])
          .map((item) => item.name)
          .sort();

      expect(await ids("")).toEqual(["Logo", "Promo", "Sunset"]);
      expect(await ids("?kind=video")).toEqual(["Promo"]);
      expect(await ids("?tag=brand")).toEqual(["Logo", "Promo"]);
      expect(await ids("?q=orange")).toEqual(["Sunset"]);
      expect(await ids("?q=100%25")).toEqual([]);
      expect(await ids("?enabled=false")).toEqual(["Logo"]);
      expect((await adminCall("media?kind=audio")).status).toBe(400);
      const listing = await (await adminCall("media")).json();
      expect(listing.tags).toEqual(["brand", "nature"]);
      expect(sunset.id).not.toBe(logo.id);
    });

    it("updates name, description, tags and enabled", async () => {
      const item = await uploadPng();
      const response = await adminCall(`media/${item.id}`, "PATCH", {
        name: "Renamed",
        description: "Use for greetings",
        tags: ["Greeting", "greeting", "Hello World"],
        enabled: false,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        name: "Renamed",
        description: "Use for greetings",
        tags: ["greeting", "hello-world"],
        enabled: false,
      });
      expect((await (await clientGet("/v1/media")).json()).data).toEqual([]);
      expect((await adminCall("media/med_missing", "PATCH", { name: "X" })).status).toBe(404);
    });

    it("deleting an upload removes its file; unknown ids are 404", async () => {
      const item = await uploadPng();
      expect(await readdir(storageDir)).toEqual([`${item.id}.png`]);
      expect((await adminCall(`media/${item.id}`, "DELETE")).status).toBe(204);
      expect(await readdir(storageDir)).toEqual([]);
      expect((await adminCall(`media/${item.id}`)).status).toBe(404);
      expect((await adminCall(`media/${item.id}`, "DELETE")).status).toBe(404);
    });
  });
});
