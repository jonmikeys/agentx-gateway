import { describe, expect, it } from "vitest";
import { cidrContains, isIpAllowed, isValidCidr, parseCidr } from "@/server/gateway/cidr";

describe("CIDR matcher", () => {
  it("matches IPv4 ranges and single addresses", () => {
    expect(isIpAllowed(["10.0.0.0/8"], "10.20.30.40")).toBe(true);
    expect(isIpAllowed(["10.0.0.0/8"], "11.0.0.1")).toBe(false);
    expect(isIpAllowed(["192.168.1.5"], "192.168.1.5")).toBe(true);
    expect(isIpAllowed(["192.168.1.5"], "192.168.1.6")).toBe(false);
    expect(isIpAllowed(["192.168.1.0/24"], "192.168.1.255")).toBe(true);
    expect(isIpAllowed(["192.168.1.0/25"], "192.168.1.200")).toBe(false);
    expect(isIpAllowed(["0.0.0.0/0"], "8.8.8.8")).toBe(true);
  });

  it("matches IPv6 ranges and compressed forms", () => {
    expect(isIpAllowed(["2001:db8::/32"], "2001:db8:ffff::1")).toBe(true);
    expect(isIpAllowed(["2001:db8::/32"], "2001:db9::1")).toBe(false);
    expect(isIpAllowed(["::1"], "0:0:0:0:0:0:0:1")).toBe(true);
    expect(isIpAllowed(["fe80::/10"], "febf::1")).toBe(true);
    expect(isIpAllowed(["fe80::/10"], "fec0::1")).toBe(false);
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(isIpAllowed(["203.0.113.0/24"], "::ffff:203.0.113.9")).toBe(true);
    expect(isIpAllowed(["::ffff:203.0.113.0/120"], "203.0.113.9")).toBe(true);
  });

  it("never matches across families", () => {
    expect(isIpAllowed(["10.0.0.0/8"], "2001:db8::1")).toBe(false);
    expect(isIpAllowed(["2001:db8::/32"], "10.0.0.1")).toBe(false);
  });

  it("allows everything for an empty list and denies unknown IPs for a non-empty list", () => {
    expect(isIpAllowed([], undefined)).toBe(true);
    expect(isIpAllowed(["10.0.0.0/8"], undefined)).toBe(false);
    expect(isIpAllowed(["10.0.0.0/8"], "not-an-ip")).toBe(false);
  });

  it("ignores invalid allowlist entries instead of allowing them", () => {
    expect(isIpAllowed(["garbage"], "10.0.0.1")).toBe(false);
  });

  it("validates entries", () => {
    for (const valid of ["1.2.3.4", "1.2.3.0/24", "::1", "2001:db8::/32", "::ffff:1.2.3.4"]) {
      expect(isValidCidr(valid), valid).toBe(true);
    }
    for (const invalid of [
      "1.2.3",
      "1.2.3.4/33",
      "1.2.3.256",
      "::/129",
      "1.2.3.4/x",
      "a/b/c",
      "",
      ":::",
    ]) {
      expect(isValidCidr(invalid), invalid).toBe(false);
    }
  });

  it("exposes parsed rules", () => {
    const rule = parseCidr("10.1.0.0/16");
    expect(rule).toBeDefined();
    if (rule) expect(cidrContains(rule, "10.1.255.255")).toBe(true);
  });
});
