import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAdminApp } from "@/server/api/admin-app";
import { closeDatabase, getDb } from "@/server/db/client";
import { apiKeys, providers } from "@/server/db/schema";
import { hashApiKey } from "@/server/gateway/api-key-format";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import { adminHeaders, prepareDatabase, resetGatewayState } from "./support";

const databaseUrl = inject("databaseUrl");
const PLAINTEXT_KEY = "sk-plaintext-provider-key-9876";

describe("admin API", () => {
  const admin = createAdminApp();
  let upstream: MockUpstream;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream({
      apiKey: PLAINTEXT_KEY,
      models: ["alpha", "beta", "gamma"],
    });
  });

  afterAll(async () => {
    await upstream.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
  });

  const call = (path: string, method = "GET", body?: unknown) =>
    admin.request(`/api/admin/${path}`, {
      method,
      headers: adminHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function createProviderViaApi(name = "Alpha") {
    const response = await call("providers", "POST", {
      name,
      base_url: upstream.url,
      api_key: PLAINTEXT_KEY,
      extra_headers: { "X-Org": "secret-org-header" },
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  it("requires admin authentication", async () => {
    const response = await admin.request("/api/admin/providers");
    expect(response.status).toBe(401);
  });

  describe("providers", () => {
    it("never returns secrets: masked key and header names only; stored encrypted", async () => {
      const created = await createProviderViaApi();
      for (const body of [
        created,
        await (await call(`providers/${created.id}`)).json(),
        await (await call("providers")).json(),
      ]) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(PLAINTEXT_KEY);
        expect(text).not.toContain("secret-org-header");
      }
      expect(created.api_key_masked).toBe("sk-…9876");
      expect(created.extra_header_names).toEqual(["X-Org"]);
      expect(created.circuit_state).toBe("closed");

      const [row] = await getDb().select().from(providers);
      expect(row.apiKey?.startsWith("v1:")).toBe(true);
      expect(row.extraHeaders?.startsWith("v1:")).toBe(true);
      expect(`${row.apiKey}${row.extraHeaders}`).not.toContain(PLAINTEXT_KEY);
    });

    it("keeps the key when update omits it and clears it with null", async () => {
      const created = await createProviderViaApi();
      const renamed = await (
        await call(`providers/${created.id}`, "PATCH", { name: "Renamed" })
      ).json();
      expect(renamed.name).toBe("Renamed");
      expect(renamed.api_key_masked).toBe("sk-…9876");
      const cleared = await (
        await call(`providers/${created.id}`, "PATCH", { api_key: null })
      ).json();
      expect(cleared.api_key_masked).toBeNull();
    });

    it("keeps omitted fields on a partial update and merges capabilities", async () => {
      const created = await (
        await call("providers", "POST", {
          name: "Partial",
          base_url: "https://api.example.com/v1",
          enabled: false,
          capabilities: { streaming: false, tools: true, responses_api: true },
        })
      ).json();

      const renamed = await (
        await call(`providers/${created.id}`, "PATCH", { name: "Partial renamed" })
      ).json();
      expect(renamed.enabled).toBe(false);
      expect(renamed.capabilities).toEqual({ streaming: false, tools: true, responses_api: true });

      const merged = await (
        await call(`providers/${created.id}`, "PATCH", { capabilities: { tools: false } })
      ).json();
      expect(merged.capabilities).toEqual({
        streaming: false,
        tools: false,
        responses_api: true,
      });
      expect(merged.name).toBe("Partial renamed");
    });

    it("supports keyless providers", async () => {
      const response = await call("providers", "POST", {
        name: "Ollama",
        base_url: "http://localhost:11434/v1",
      });
      expect(response.status).toBe(201);
      expect((await response.json()).api_key_masked).toBeNull();
    });

    it("validates input and rejects duplicate names", async () => {
      const bad = await call("providers", "POST", { name: "", base_url: "not-a-url" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe("validation_error");
      await createProviderViaApi("Dup");
      const duplicate = await call("providers", "POST", { name: "Dup", base_url: upstream.url });
      expect(duplicate.status).toBe(409);
    });

    it("tests the connection and reports latency and model count", async () => {
      const created = await createProviderViaApi();
      const result = await (await call(`providers/${created.id}/test`, "POST")).json();
      expect(result).toMatchObject({
        ok: true,
        model_count: 3,
        models: ["alpha", "beta", "gamma"],
        error: null,
      });
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      expect(upstream.requests.at(-1)?.headers.authorization).toBe(`Bearer ${PLAINTEXT_KEY}`);
    });

    it("reports a failed connection test", async () => {
      const keyless = await (
        await call("providers", "POST", { name: "NoKey", base_url: upstream.url })
      ).json();
      const result = await (await call(`providers/${keyless.id}/test`, "POST")).json();
      expect(result).toMatchObject({ ok: false, error: "HTTP 401" });

      const dead = await (
        await call("providers", "POST", { name: "Dead", base_url: "http://127.0.0.1:1" })
      ).json();
      const deadResult = await (await call(`providers/${dead.id}/test`, "POST")).json();
      expect(deadResult.ok).toBe(false);
      expect(deadResult.error).toBeTruthy();
    });

    it("blocks deleting a provider used by a route and names the route", async () => {
      const provider = await createProviderViaApi();
      await call("routes", "POST", {
        slug: "avatar-default",
        steps: [{ provider_id: provider.id, upstream_model: "ok" }],
      });
      const response = await call(`providers/${provider.id}`, "DELETE");
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe("provider_in_use");
      expect(body.error.details.routes).toEqual(["avatar-default"]);
    });

    it("deletes an unused provider", async () => {
      const provider = await createProviderViaApi();
      expect((await call(`providers/${provider.id}`, "DELETE")).status).toBe(204);
      expect((await call(`providers/${provider.id}`)).status).toBe(404);
    });
  });

  describe("routes", () => {
    it("creates routes with ordered steps; the first becomes the default; steps are replaced on update", async () => {
      const a = await createProviderViaApi("A");
      const b = await createProviderViaApi("B");
      const created = await (
        await call("routes", "POST", {
          slug: "avatar-default",
          description: "main",
          steps: [
            { provider_id: a.id, upstream_model: "m1", timeout_ms: 5000 },
            { provider_id: b.id, upstream_model: "m2" },
          ],
        })
      ).json();
      expect(created.is_default).toBe(true);
      expect(created.steps.map((step: { provider_name: string }) => step.provider_name)).toEqual([
        "A",
        "B",
      ]);
      expect(created.steps[1].timeout_ms).toBe(30000);

      const updated = await (
        await call(`routes/${created.id}`, "PUT", {
          slug: "avatar-default",
          steps: [
            { provider_id: b.id, upstream_model: "m2" },
            { provider_id: a.id, upstream_model: "m1" },
          ],
        })
      ).json();
      expect(
        updated.steps.map((step: { position: number; provider_name: string }) => [
          step.position,
          step.provider_name,
        ]),
      ).toEqual([
        [0, "B"],
        [1, "A"],
      ]);
    });

    it("keeps exactly one default route", async () => {
      const a = await createProviderViaApi("A");
      const step = { provider_id: a.id, upstream_model: "m" };
      const first = await (await call("routes", "POST", { slug: "one", steps: [step] })).json();
      const second = await (await call("routes", "POST", { slug: "two", steps: [step] })).json();
      expect(second.is_default).toBe(false);
      await call(`routes/${second.id}/default`, "POST");
      const list = (await (await call("routes")).json()).data as {
        slug: string;
        is_default: boolean;
      }[];
      expect(list.filter((route) => route.is_default).map((route) => route.slug)).toEqual(["two"]);

      const deleteDefault = await call(`routes/${second.id}`, "DELETE");
      expect(deleteDefault.status).toBe(409);
      expect((await call(`routes/${first.id}`, "DELETE")).status).toBe(204);
    });

    it("rejects invalid slugs, the reserved 'default' slug, and duplicates", async () => {
      const a = await createProviderViaApi("A");
      const step = { provider_id: a.id, upstream_model: "m" };
      expect((await call("routes", "POST", { slug: "Bad Slug", steps: [step] })).status).toBe(400);
      expect((await call("routes", "POST", { slug: "default", steps: [step] })).status).toBe(400);
      expect((await call("routes", "POST", { slug: "x", steps: [] })).status).toBe(400);
      await call("routes", "POST", { slug: "x", steps: [step] });
      expect((await call("routes", "POST", { slug: "x", steps: [step] })).status).toBe(409);
    });
  });

  describe("api keys", () => {
    it("returns the plaintext key once, stores only its hash, and lists metadata", async () => {
      const response = await call("api-keys", "POST", { label: "Lobby kiosk", rpm_limit: 60 });
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.key).toMatch(/^agx_[0-9A-Za-z]{32}$/);
      expect(created.key_prefix).toBe(created.key.slice(0, 8));

      const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, created.id));
      expect(row.keyHash).toBe(hashApiKey(created.key));
      expect(JSON.stringify(row)).not.toContain(created.key);

      const list = await (await call("api-keys")).json();
      expect(JSON.stringify(list)).not.toContain(created.key);
      expect(list.data[0]).toMatchObject({ label: "Lobby kiosk", rpm_limit: 60, revoked_at: null });
    });

    it("updates label, allowlist and limits, and validates the allowlist", async () => {
      const created = await (await call("api-keys", "POST", { label: "k" })).json();
      const updated = await (
        await call(`api-keys/${created.id}`, "PATCH", {
          label: "renamed",
          ip_allowlist: ["10.0.0.0/8"],
          tokens_per_day_limit: 1000,
        })
      ).json();
      expect(updated).toMatchObject({
        label: "renamed",
        ip_allowlist: ["10.0.0.0/8"],
        tokens_per_day_limit: 1000,
      });
      const bad = await call(`api-keys/${created.id}`, "PATCH", { ip_allowlist: ["nope"] });
      expect(bad.status).toBe(400);
    });

    it("revokes keys", async () => {
      const created = await (await call("api-keys", "POST", { label: "k" })).json();
      const revoked = await (await call(`api-keys/${created.id}/revoke`, "POST")).json();
      expect(revoked.revoked_at).toBeTruthy();
      expect(
        (await call("api-keys/00000000-0000-0000-0000-000000000000/revoke", "POST")).status,
      ).toBe(404);
    });
  });
});
