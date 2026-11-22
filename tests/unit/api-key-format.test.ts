import { describe, expect, it } from "vitest";
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from "@/server/gateway/api-key-format";
import { getForwardedIp, parseBearerToken } from "@/server/gateway/client-auth";

describe("API key format", () => {
  it("generates agx_ + 32 base62 characters", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(generateApiKey()).toMatch(/^agx_[0-9A-Za-z]{32}$/);
    }
  });

  it("generates distinct keys", () => {
    expect(new Set(Array.from({ length: 50 }, generateApiKey)).size).toBe(50);
  });

  it("hashes to a stable SHA-256 hex digest", () => {
    expect(hashApiKey("agx_test")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("agx_test")).toBe(hashApiKey("agx_test"));
    expect(hashApiKey("agx_test")).not.toBe(hashApiKey("agx_Test"));
  });

  it("uses the first 8 characters as the display prefix", () => {
    expect(apiKeyDisplayPrefix("agx_ab12CDEFGHIJ")).toBe("agx_ab12");
  });
});

describe("client auth helpers", () => {
  it("parses bearer tokens", () => {
    expect(parseBearerToken("Bearer agx_x")).toBe("agx_x");
    expect(parseBearerToken("bearer   agx_x ")).toBe("agx_x");
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken(null)).toBeUndefined();
    expect(parseBearerToken("Bearer")).toBeUndefined();
  });

  it("takes the first X-Forwarded-For entry, then X-Real-IP, and validates them", () => {
    expect(getForwardedIp(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe(
      "203.0.113.5",
    );
    expect(getForwardedIp(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(getForwardedIp(new Headers({ "x-forwarded-for": "garbage" }))).toBeUndefined();
    expect(getForwardedIp(new Headers())).toBeUndefined();
  });
});
