import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAdminApp } from "@/server/api/admin-app";
import { createApiApp } from "@/server/api/app";
import { encryptedColumns } from "@/server/crypto/encrypted-columns";
import { rotateSecrets } from "@/server/crypto/rotate";
import { decryptSecretWithKey, generateEncryptionKey } from "@/server/crypto/secrets";
import { closeDatabase } from "@/server/db/client";
import { type MockMjpeg, startMockMjpeg } from "../support/mock-mjpeg";
import { adminHeaders, prepareDatabase, resetGatewayState, seedApiKey } from "./support";

const databaseUrl = inject("databaseUrl");
const PASSWORD = "cam-password-8841";
const USERNAME = "camviewer";

describe("cameras API", () => {
  const admin = createAdminApp();
  const api = createApiApp();
  let camera: MockMjpeg;
  let key: string;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    camera = await startMockMjpeg({
      auth: { username: USERNAME, password: PASSWORD },
      frameIntervalMs: 20,
    });
  });

  afterAll(async () => {
    await camera.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    camera.authHeaders.length = 0;
    key = (await seedApiKey()).key;
  });

  const call = (path: string, method = "GET", body?: unknown) =>
    admin.request(`/api/admin/${path}`, {
      method,
      headers: adminHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const clientCameras = () =>
    api.request("/v1/cameras", { headers: { Authorization: `Bearer ${key}` } });

  async function createMjpeg(overrides: Record<string, unknown> = {}) {
    const response = await call("cameras", "POST", {
      type: "mjpeg_url",
      name: "Lobby",
      description: "Lobby camera",
      url: camera.streamUrl,
      credentials: { username: USERNAME, password: PASSWORD },
      ...overrides,
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  async function createLookAt(name = "Look-at") {
    const response = await call("cameras", "POST", { type: "lookat_sidecar", name });
    expect(response.status).toBe(201);
    return response.json();
  }

  describe("CRUD", () => {
    it("creates both types and lists them in creation order", async () => {
      const lookAt = await createLookAt();
      const mjpeg = await createMjpeg();
      expect(lookAt).toMatchObject({ type: "lookat_sidecar", url: null, previewable: false });
      expect(mjpeg).toMatchObject({ type: "mjpeg_url", url: camera.streamUrl, previewable: true });
      expect(lookAt.id).toMatch(/^cam_[0-9a-f]{12}$/);
      const list = (await (await call("cameras")).json()).data;
      expect(list.map((entry: { id: string }) => entry.id)).toEqual([lookAt.id, mjpeg.id]);
    });

    it("validates the type union", async () => {
      expect((await call("cameras", "POST", { type: "mjpeg_url", name: "No url" })).status).toBe(
        400,
      );
      expect(
        (
          await call("cameras", "POST", {
            type: "mjpeg_url",
            name: "Bad",
            url: "rtsp://cam/stream",
          })
        ).status,
      ).toBe(400);
      expect((await call("cameras", "POST", { type: "rtsp_via_relay", name: "Door" })).status).toBe(
        400,
      );
      expect((await call("cameras", "POST", { name: "Typeless" })).status).toBe(400);
    });

    it("updates fields, switches types and deletes", async () => {
      const mjpeg = await createMjpeg();
      const renamed = await call(`cameras/${mjpeg.id}`, "PATCH", { name: "Hall", enabled: false });
      expect(await renamed.json()).toMatchObject({ name: "Hall", enabled: false });

      const toLookAt = await call(`cameras/${mjpeg.id}`, "PATCH", { type: "lookat_sidecar" });
      expect(await toLookAt.json()).toMatchObject({
        type: "lookat_sidecar",
        url: null,
        credentials: null,
      });

      const invalid = await call(`cameras/${mjpeg.id}`, "PATCH", { type: "mjpeg_url" });
      expect(invalid.status).toBe(400);

      expect((await call(`cameras/${mjpeg.id}`, "DELETE")).status).toBe(204);
      expect((await call(`cameras/${mjpeg.id}`)).status).toBe(404);
      expect((await call("cameras/cam_missing", "PATCH", { name: "x" })).status).toBe(404);
    });

    it("reorders cameras and rejects unknown or repeated ids", async () => {
      const first = await createLookAt("First");
      const second = await createMjpeg({ name: "Second" });
      const third = await createLookAt("Third");
      const reordered = await call("cameras/reorder", "POST", {
        ids: [third.id, first.id, second.id],
      });
      expect(reordered.status).toBe(200);
      const names = (await (await call("cameras")).json()).data.map(
        (entry: { name: string }) => entry.name,
      );
      expect(names).toEqual(["Third", "First", "Second"]);
      expect((await call("cameras/reorder", "POST", { ids: ["cam_nope"] })).status).toBe(400);
      expect((await call("cameras/reorder", "POST", { ids: [first.id, first.id] })).status).toBe(
        400,
      );
    });

    it("requires admin authentication", async () => {
      expect((await admin.request("/api/admin/cameras")).status).toBe(401);
    });
  });

  describe("credentials", () => {
    it("are encrypted at rest and never returned to the admin", async () => {
      const created = await createMjpeg();
      const everything = JSON.stringify([
        created,
        await (await call(`cameras/${created.id}`)).json(),
        await (await call("cameras")).json(),
      ]);
      expect(everything).not.toContain(PASSWORD);
      expect(everything).not.toContain(USERNAME);
      expect(created.credentials).toEqual({ username_masked: "c••••••r", has_password: true });

      const sql = postgres(databaseUrl);
      try {
        const [row] = await sql<{ credentials: string }[]>`select credentials from cameras`;
        expect(row.credentials).toMatch(/^v1:/);
        expect(row.credentials).not.toContain(PASSWORD);
      } finally {
        await sql.end();
      }
    });

    it("keep, replace and clear through updates", async () => {
      const created = await createMjpeg();
      const kept = await call(`cameras/${created.id}`, "PATCH", { name: "Renamed" });
      expect((await kept.json()).credentials).not.toBeNull();
      const replaced = await call(`cameras/${created.id}`, "PATCH", {
        credentials: { username: "other", password: "other-password" },
      });
      expect((await replaced.json()).credentials.username_masked).toBe("o•••r");
      const cleared = await call(`cameras/${created.id}`, "PATCH", { credentials: null });
      expect((await cleared.json()).credentials).toBeNull();
    });

    it("are covered by secret rotation", async () => {
      expect(encryptedColumns).toContainEqual({
        table: "cameras",
        column: "credentials",
        primaryKey: ["id"],
      });
      await createMjpeg();
      const oldKey = Buffer.alloc(32, 7).toString("base64");
      const newKey = generateEncryptionKey();
      const sql = postgres(databaseUrl);
      try {
        const rotated = await rotateSecrets(sql, oldKey, newKey, encryptedColumns);
        expect(rotated).toBe(1);
        const [row] = await sql<{ credentials: string }[]>`select credentials from cameras`;
        expect(JSON.parse(decryptSecretWithKey(row.credentials, newKey))).toEqual({
          username: USERNAME,
          password: PASSWORD,
        });
      } finally {
        await sql.end();
      }
    });
  });

  describe("client catalogue", () => {
    it("lists enabled cameras in sort order with type-specific fields", async () => {
      const lookAt = await createLookAt("Look-at sidecar");
      const mjpeg = await createMjpeg({ name: "Lobby" });
      await createMjpeg({ name: "Disabled", enabled: false });
      const open = await createMjpeg({
        name: "Open",
        credentials: null,
        url: `${camera.url}/plain`,
      });
      await call("cameras/reorder", "POST", { ids: [open.id, lookAt.id, mjpeg.id] });

      const response = await clientCameras();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        object: "list",
        data: [
          {
            id: open.id,
            name: "Open",
            description: "Lobby camera",
            type: "mjpeg_url",
            url: `${camera.url}/plain`,
          },
          { id: lookAt.id, name: "Look-at sidecar", description: "", type: "lookat_sidecar" },
          {
            id: mjpeg.id,
            name: "Lobby",
            description: "Lobby camera",
            type: "mjpeg_url",
            url: camera.streamUrl,
            credentials: { username: USERNAME, password: PASSWORD },
          },
        ],
      });
    });

    it("requires a Bearer key", async () => {
      expect((await api.request("/v1/cameras")).status).toBe(401);
    });
  });

  describe("connection test", () => {
    it("passes for an MJPEG stream, sending the credentials", async () => {
      const created = await createMjpeg();
      const response = await call(`cameras/${created.id}/test`, "POST");
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.error ?? "").toBe("");
      expect(result.ok).toBe(true);
      expect(result.content_type).toContain("multipart/x-mixed-replace");
      expect(camera.authHeaders[0]).toMatch(/^Basic /);
    });

    it("explains a wrong password, a non-MJPEG URL and a stream with no frames", async () => {
      const wrong = await createMjpeg({ credentials: { username: USERNAME, password: "nope" } });
      const denied = await (await call(`cameras/${wrong.id}/test`, "POST")).json();
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("401");
      expect(JSON.stringify(denied)).not.toContain("nope");

      const plain = await createMjpeg({ url: `${camera.url}/plain`, credentials: null });
      const notStream = await (await call(`cameras/${plain.id}/test`, "POST")).json();
      expect(notStream).toMatchObject({ ok: false, content_type: "text/plain" });
      expect(notStream.error).toContain("multipart/x-mixed-replace");

      const silent = await createMjpeg({
        url: `${camera.url}/missing-boundary`,
        credentials: { username: USERNAME, password: PASSWORD },
      });
      const timedOut = await (await call(`cameras/${silent.id}/test`, "POST")).json();
      expect(timedOut.ok).toBe(false);
      expect(timedOut.error).toMatch(/5 seconds/);
    });

    it("is not available for lookat_sidecar or unknown ids", async () => {
      const lookAt = await createLookAt();
      const response = await call(`cameras/${lookAt.id}/test`, "POST");
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("test_unsupported");
      expect((await call("cameras/cam_missing/test", "POST")).status).toBe(404);
    });
  });

  describe("preview proxy", () => {
    it("streams the MJPEG feed to the admin with the stored credentials", async () => {
      const created = await createMjpeg();
      const response = await call(`cameras/${created.id}/preview`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value ?? []).toString("latin1")).toContain("--mockframe");
      await reader.cancel();
      expect(camera.authHeaders.at(-1)).toMatch(/^Basic /);
    });

    it("is admin-only and unavailable for lookat_sidecar", async () => {
      const created = await createMjpeg();
      expect((await admin.request(`/api/admin/cameras/${created.id}/preview`)).status).toBe(401);
      const lookAt = await createLookAt();
      const response = await call(`cameras/${lookAt.id}/preview`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("preview_unsupported");
    });

    it("answers 502 when the camera refuses the connection", async () => {
      const denied = await createMjpeg({ credentials: { username: USERNAME, password: "bad" } });
      const response = await call(`cameras/${denied.id}/preview`);
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe("camera_unavailable");
    });
  });
});
