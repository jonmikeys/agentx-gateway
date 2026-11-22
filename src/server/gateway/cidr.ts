/** Isomorphic (no Node imports) so CRM forms can validate allowlist entries client-side. */

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);
const HEXTET = /^[0-9a-fA-F]{1,4}$/;

interface ParsedIp {
  bits: bigint;
  size: 32 | 128;
}

/** Parses an IPv4 or IPv6 address into an integer plus its bit length. Undefined when invalid. */
export function parseIp(value: string): ParsedIp | undefined {
  const text = value.trim();
  if (IPV4.test(text)) {
    const bits = text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(part), 0n);
    return { bits, size: 32 };
  }
  return text.includes(":") ? parseIpv6(text) : undefined;
}

function parseIpv6(text: string): ParsedIp | undefined {
  let address = text.split("%")[0];
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (tail) {
    const v4 = parseIp(tail[1]);
    if (!v4) return undefined;
    const high = Number((v4.bits >> 16n) & 0xffffn).toString(16);
    const low = Number(v4.bits & 0xffffn).toString(16);
    address = `${address.slice(0, -tail[1].length)}${high}:${low}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const filler = Array<string>(halves.length === 2 ? missing : 0).fill("0");
  const groups = [...head, ...filler, ...rest];
  if (!groups.every((group) => HEXTET.test(group))) return undefined;
  let bits = 0n;
  for (const group of groups) {
    bits = (bits << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return { bits, size: 128 };
}

/** IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are treated as the IPv4 address. */
function normalize(ip: ParsedIp): ParsedIp {
  if (ip.size === 128 && ip.bits >> 32n === 0xffffn) {
    return { bits: ip.bits & 0xffffffffn, size: 32 };
  }
  return ip;
}

export interface CidrRule {
  bits: bigint;
  size: 32 | 128;
  prefix: number;
}

/** Parses `1.2.3.4`, `10.0.0.0/8`, `::1` or `2001:db8::/32`. Undefined when invalid. */
export function parseCidr(value: string): CidrRule | undefined {
  const [address, prefixText, extra] = value.trim().split("/");
  if (extra !== undefined) return undefined;
  const parsed = parseIp(address);
  if (!parsed) return undefined;
  const ip = normalize(parsed);
  const shift = ip.size === 32 && parsed.size === 128 ? 96 : 0;
  let prefix = ip.size as number;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) return undefined;
    if (Number(prefixText) > parsed.size) return undefined;
    prefix = Number(prefixText) - shift;
    if (prefix < 0) return undefined;
  }
  return { bits: ip.bits, size: ip.size, prefix };
}

export function isValidCidr(value: string): boolean {
  return parseCidr(value) !== undefined;
}

/** True when `ipText` falls inside the rule. Different address families never match. */
export function cidrContains(rule: CidrRule, ipText: string): boolean {
  const parsed = parseIp(ipText);
  if (!parsed) return false;
  const ip = normalize(parsed);
  if (ip.size !== rule.size) return false;
  const shift = BigInt(rule.size - rule.prefix);
  return ip.bits >> shift === rule.bits >> shift;
}

/** Matches an address against a list of IPs/CIDRs. An empty list allows everything. */
export function isIpAllowed(allowlist: string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  return allowlist.some((entry) => {
    const rule = parseCidr(entry);
    return rule ? cidrContains(rule, ip) : false;
  });
}
