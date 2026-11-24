import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

/**
 * Outbound HTTP for content picked by the model or found on the web (docs/web-search.md):
 * http/https only, public addresses only. Loopback, private, link-local, CGNAT, multicast and
 * reserved ranges are refused, for literal IPs and for every address DNS returns, at connect
 * time (so DNS rebinding cannot slip through) and again on every redirect hop.
 */

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** IPv4 embedded in an IPv6 address (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64 `64:ff9b::/96`). */
function embeddedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

let testAllowedAddresses = new Set<string>();

/**
 * Tests run their mock servers on 127.0.0.1: addresses listed here count as public. Every other
 * private address stays blocked, so redirect checks remain testable. Production never calls this.
 */
export function setTestAllowedAddresses(addresses: string[]): void {
  testAllowedAddresses = new Set(addresses);
}

/** Whether an IP address may be contacted. Non-IP strings are never public. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (testAllowedAddresses.has(bare)) return true;
  const family = isIP(bare);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(bare, "ipv4");
  const v4 = embeddedIpv4(bare);
  if (v4) return isIP(v4) === 4 && !blocked.check(v4, "ipv4");
  return !blocked.check(bare, "ipv6");
}

export type PublicFetchErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "too_many_redirects"
  | "timeout"
  | "unreachable";

/** A failure safe to show the model: it names the problem, never internal addresses. */
export class PublicFetchError extends Error {
  readonly code: PublicFetchErrorCode;

  constructor(code: PublicFetchErrorCode, message: string) {
    super(message);
    this.name = "PublicFetchError";
    this.code = code;
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup` that drops non-public addresses and fails when none is left. */
function publicLookup(
  hostname: string,
  options: { family?: number; all?: boolean; hints?: number },
  callback: LookupCallback,
): void {
  const lookupOptions: LookupAllOptions = {
    all: true,
    family: options.family as LookupAllOptions["family"],
    hints: options.hints,
  };
  dnsLookup(hostname, lookupOptions, (error, addresses) => {
    if (error) return callback(error, options.all ? [] : "", 0);
    const allowed = addresses.filter((entry) => isPublicAddress(entry.address));
    if (allowed.length === 0) {
      const refused = Object.assign(new Error("blocked_address"), { code: "EBLOCKED" });
      return callback(refused, options.all ? [] : "", 0);
    }
    if (options.all) return callback(null, allowed);
    return callback(null, allowed[0].address, allowed[0].family);
  });
}

let agent: Dispatcher | undefined;

function publicAgent(): Dispatcher {
  agent ??= new Agent({
    connect: { lookup: publicLookup as never, timeout: 10_000 },
    headersTimeout: 15_000,
    bodyTimeout: 30_000,
  });
  return agent;
}

/** Parses and checks a URL: http/https, no credentials, and no literal non-public IP. */
export function checkPublicUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicFetchError("invalid_url", "That is not a valid web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicFetchError("invalid_url", "Only http and https addresses can be opened.");
  }
  if (url.username || url.password) {
    throw new PublicFetchError("invalid_url", "Addresses with credentials cannot be opened.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new PublicFetchError("blocked_address", "Private network addresses cannot be opened.");
  }
  if (/^(localhost|.*\.localhost)$/i.test(host)) {
    throw new PublicFetchError("blocked_address", "Private network addresses cannot be opened.");
  }
  return url;
}

export interface PublicFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Redirect hops followed (each re-checked). Default 5. */
  maxRedirects?: number;
}

export interface PublicFetchResult {
  response: Response;
  /** The URL that answered, after redirects. */
  url: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function isBlockedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const entry = current as { code?: string; message?: string; cause?: unknown };
    if (entry.code === "EBLOCKED" || entry.message === "blocked_address") return true;
    current = entry.cause;
  }
  return false;
}

/** Fetches a public http(s) URL, following and re-checking redirects itself. */
export async function publicFetch(
  raw: string,
  options: PublicFetchOptions = {},
): Promise<PublicFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  let url = checkPublicUrl(raw);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = (await undiciFetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        redirect: "manual",
        signal: options.signal,
        dispatcher: publicAgent(),
      })) as unknown as Response;
    } catch (error) {
      if (isBlockedError(error)) {
        throw new PublicFetchError(
          "blocked_address",
          "Private network addresses cannot be opened.",
        );
      }
      if (options.signal?.aborted) {
        throw new PublicFetchError("timeout", "The site did not answer in time.");
      }
      throw new PublicFetchError("unreachable", "The site could not be reached.");
    }
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || !location) return { response, url: url.toString() };
    await response.body?.cancel();
    if (hop >= maxRedirects) {
      throw new PublicFetchError("too_many_redirects", "The address redirects too many times.");
    }
    url = checkPublicUrl(new URL(location, url));
  }
}

/** Reads at most `maxBytes` of a body; `truncated` says whether more was available. */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      total += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}
