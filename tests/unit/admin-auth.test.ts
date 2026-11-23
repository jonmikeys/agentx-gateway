import { describe, expect, it } from "vitest";
import {
  BasicAdminAuth,
  getClientIp,
  guardAdminRequest,
  parseBasicAuthHeader,
} from "@/server/auth/admin-auth";
import { FailedLoginLimiter } from "@/server/auth/rate-limit";

const credentials = { username: "admin", password: "p@ss:word" };
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const requestWith = (authorization?: string, ip = "203.0.113.5") =>
  new Request("http://localhost/api/admin/me", {
    headers: { ...(authorization ? { authorization } : {}), "x-forwarded-for": ip },
  });

function statusOf(result: Awaited<ReturnType<typeof guardAdminRequest>>): number | undefined {
  return "response" in result ? result.response.status : undefined;
}

describe("parseBasicAuthHeader", () => {
  it("parses credentials and keeps colons in the password", () => {
    expect(parseBasicAuthHeader(basic("admin", "p@ss:word"))).toEqual(credentials);
  });

  it("returns undefined for missing, non-basic or malformed headers", () => {
    expect(parseBasicAuthHeader(null)).toBeUndefined();
    expect(parseBasicAuthHeader("Bearer abc")).toBeUndefined();
    expect(parseBasicAuthHeader("Basic !!!")).toBeUndefined();
    expect(
      parseBasicAuthHeader(`Basic ${Buffer.from("nocolon").toString("base64")}`),
    ).toBeUndefined();
  });
});

describe("BasicAdminAuth", () => {
  const auth = new BasicAdminAuth(credentials);

  it("accepts matching credentials", () => {
    expect(auth.authenticate(requestWith(basic("admin", "p@ss:word")))).toEqual({
      ok: true,
      username: "admin",
    });
  });

  it("rejects wrong user, wrong password and missing header", () => {
    expect(auth.authenticate(requestWith(basic("root", "p@ss:word")))).toEqual({ ok: false });
    expect(auth.authenticate(requestWith(basic("admin", "nope")))).toEqual({ ok: false });
    expect(auth.authenticate(requestWith())).toEqual({ ok: false });
  });
});

describe("getClientIp", () => {
  it("uses the rightmost forwarded address, which the nearest proxy appended", () => {
    const request = new Request("http://localhost/api/admin/me", {
      headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.5" },
    });
    expect(getClientIp(request)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip and then a constant", () => {
    expect(
      getClientIp(
        new Request("http://localhost/api/admin/me", { headers: { "x-real-ip": "203.0.113.7" } }),
      ),
    ).toBe("203.0.113.7");
    expect(getClientIp(new Request("http://localhost/api/admin/me"))).toBe("unknown");
  });
});

describe("guardAdminRequest", () => {
  it("returns 401 with a Basic challenge when no credentials are sent", async () => {
    const result = await guardAdminRequest(
      requestWith(),
      new BasicAdminAuth(credentials),
      new FailedLoginLimiter(),
    );
    expect(statusOf(result)).toBe(401);
    expect("response" in result && result.response.headers.get("www-authenticate")).toBe(
      'Basic realm="AGENTX Gateway", charset="UTF-8"',
    );
  });

  it("blocks an IP with 429 after 10 failures, even with correct credentials", async () => {
    let now = 1_000_000;
    const limiter = new FailedLoginLimiter({ now: () => now });
    const auth = new BasicAdminAuth(credentials);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await guardAdminRequest(requestWith(basic("admin", "wrong")), auth, limiter);
      expect(statusOf(result)).toBe(401);
    }
    const blocked = await guardAdminRequest(
      requestWith(basic("admin", "p@ss:word")),
      auth,
      limiter,
    );
    expect(statusOf(blocked)).toBe(429);
    expect("response" in blocked && blocked.response.headers.get("retry-after")).toBe("300");

    const other = await guardAdminRequest(
      requestWith(basic("admin", "p@ss:word"), "198.51.100.9"),
      auth,
      limiter,
    );
    expect(other).toEqual({ username: "admin" });

    now += 5 * 60_000 + 1;
    const after = await guardAdminRequest(requestWith(basic("admin", "p@ss:word")), auth, limiter);
    expect(after).toEqual({ username: "admin" });
  });

  it("forgets failures older than the window", () => {
    let now = 0;
    const limiter = new FailedLoginLimiter({ now: () => now });
    for (let attempt = 0; attempt < 9; attempt += 1) limiter.recordFailure("1.1.1.1");
    now += 5 * 60_000 + 1;
    limiter.recordFailure("1.1.1.1");
    expect(limiter.blockedForSeconds("1.1.1.1")).toBe(0);
  });

  it("does not let a client pick its own bucket by varying a forwarded prefix", async () => {
    const limiter = new FailedLoginLimiter();
    const auth = new BasicAdminAuth(credentials);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const request = new Request("http://localhost/api/admin/me", {
        headers: {
          authorization: basic("admin", "wrong"),
          "x-forwarded-for": `10.0.0.${attempt}, 203.0.113.5`,
        },
      });
      expect(statusOf(await guardAdminRequest(request, auth, limiter))).toBe(401);
    }
    const blocked = await guardAdminRequest(
      requestWith(basic("admin", "p@ss:word"), "203.0.113.5"),
      auth,
      limiter,
    );
    expect(statusOf(blocked)).toBe(429);
  });

  it("prunes expired blocks and stale histories while keeping active blocks", () => {
    let now = 0;
    const limiter = new FailedLoginLimiter({
      maxFailures: 2,
      blockMs: 10_000,
      windowMs: 1_000,
      now: () => now,
    });
    limiter.recordFailure("198.51.100.1");
    limiter.recordFailure("198.51.100.1");
    expect(limiter.blockedForSeconds("198.51.100.1")).toBe(10);

    // Fill the limiter so recordFailure runs the global cleanup pass.
    for (let i = 0; i < 1000; i += 1) limiter.recordFailure(`10.${i >> 8}.${i & 255}.1`);

    now = 2_000;
    limiter.prune();
    expect(limiter.blockedForSeconds("198.51.100.1")).toBe(8);
    expect(limiter.trackedIps).toBe(1);

    now = 12_000;
    limiter.prune();
    expect(limiter.blockedForSeconds("198.51.100.1")).toBe(0);
    expect(limiter.trackedIps).toBe(0);
  });
});
