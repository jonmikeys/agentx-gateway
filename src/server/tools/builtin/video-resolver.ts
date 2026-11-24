import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getEnv } from "@/server/env";
import { checkPublicUrl, isPublicAddress, PublicFetchError } from "@/server/net/public-fetch";
import type { ResolvedStream, WebMediaRow } from "@/server/services/web-media";

/**
 * Lazy video resolution with yt-dlp (docs/web-search.md): the page URL of a found video becomes
 * a direct stream URL on the first playback request. yt-dlp is bundled in the gateway image at a
 * pinned version and uses the image's Node as its JavaScript runtime (YouTube needs one).
 */

/** Best single file that already has picture and sound, MP4, direct http(s), at most 720p. */
export const YTDLP_FORMAT =
  "b[ext=mp4][vcodec!=none][acodec!=none][protocol~='^https?$'][height<=?720]";
export const YTDLP_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Headers from yt-dlp that the proxy may forward upstream (never cookies). */
const FORWARDED_HEADERS = new Set(["user-agent", "accept", "accept-language", "referer", "origin"]);

export function ytDlpPath(): string {
  return getEnv().YTDLP_PATH ?? "yt-dlp";
}

export function buildYtDlpArgs(pageUrl: string): string[] {
  return [
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-cache-dir",
    "--ignore-config",
    "--js-runtimes",
    "node",
    "--format",
    YTDLP_FORMAT,
    "--",
    pageUrl,
  ];
}

/** Picks the stream out of yt-dlp's JSON; throws a readable Error when it is unusable. */
export function parseYtDlpOutput(stdout: string): ResolvedStream {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("The video page could not be read.");
  }
  const url = typeof info.url === "string" ? info.url : undefined;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("This video has no direct MP4 with picture and sound at 720p or below.");
  }
  const headers: Record<string, string> = {};
  const raw = info.http_headers;
  if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && FORWARDED_HEADERS.has(name.toLowerCase())) {
        headers[name] = value;
      }
    }
  }
  return { url, mimeType: info.ext === "webm" ? "video/webm" : "video/mp4", headers };
}

/** First yt-dlp error line without the `ERROR: [extractor] id:` prefix, for the model. */
export function ytDlpErrorMessage(stderr: string): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("ERROR:")) ?? "";
  if (/requested format is not available/i.test(line)) {
    return "This video has no MP4 with picture and sound at 720p or below.";
  }
  if (/unsupported url/i.test(line)) return "This video site is not supported.";
  const message = line
    .replace(/^ERROR:\s*/, "")
    .replace(/^\[[^\]]+\]\s*[^:\s]+:\s*/, "")
    .trim();
  if (!message) return "The video could not be resolved.";
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}

export type YtDlpRunner = (
  args: string[],
  signal?: AbortSignal,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const spawnRunner: YtDlpRunner = (args, signal) =>
  new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(YTDLP_TIMEOUT_MS);
    const child = spawn(ytDlpPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
        reject(new Error("Resolving the video took too long."));
      } else {
        reject(new Error("Video playback is not available (yt-dlp could not be started)."));
      }
    });
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });

let runner: YtDlpRunner = spawnRunner;
let availability: boolean | undefined;

/** Tests replace yt-dlp with a fake; `undefined` restores the real one. */
export function setYtDlpForTests(
  fake: { runner?: YtDlpRunner; available?: boolean } | undefined,
): void {
  runner = fake?.runner ?? spawnRunner;
  availability = fake?.available;
}

/** Whether yt-dlp can be started on this host (checked once per process). */
export function isYtDlpAvailable(): boolean {
  if (availability === undefined) {
    const probe = spawnSync(ytDlpPath(), ["--version"], {
      timeout: 15_000,
      windowsHide: true,
      encoding: "utf8",
    });
    availability = probe.status === 0;
  }
  return availability;
}

/** Refuses page URLs that point at private hosts before yt-dlp fetches them. */
async function assertPublicPage(pageUrl: string): Promise<void> {
  const url = checkPublicUrl(pageUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new PublicFetchError("unreachable", "The video site could not be reached.");
  }
  if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
    throw new PublicFetchError("blocked_address", "Private network addresses cannot be opened.");
  }
}

/** Resolves a temporary video item's page to a direct stream URL. */
export async function resolveVideoStream(
  row: WebMediaRow,
  signal?: AbortSignal,
): Promise<ResolvedStream> {
  await assertPublicPage(row.mediaUrl);
  const result = await runner(buildYtDlpArgs(row.mediaUrl), signal);
  if (result.code !== 0) throw new Error(ytDlpErrorMessage(result.stderr));
  return parseYtDlpOutput(result.stdout);
}
