export const MJPEG_TEST_TIMEOUT_MS = 5000;
const MAX_TEST_BYTES = 2 * 1024 * 1024;

export interface CameraCredentials {
  username: string;
  password: string;
}

export interface MjpegTestResult {
  ok: boolean;
  latency_ms: number;
  content_type: string | null;
  error?: string;
}

export function basicAuthHeader(credentials: CameraCredentials | null): Record<string, string> {
  if (!credentials) return {};
  const token = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function boundaryOf(contentType: string): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

/**
 * Connects to an MJPEG stream and checks it looks like one: a 2xx answer with a
 * `multipart/x-mixed-replace` content type, then at least one frame boundary within the
 * timeout. Always closes the connection. Errors are phrased for the CRM and never include the
 * URL or credentials.
 */
export async function testMjpegStream(
  url: string,
  credentials: CameraCredentials | null,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<MjpegTestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MJPEG_TEST_TIMEOUT_MS);
  const result = (partial: Omit<MjpegTestResult, "latency_ms">): MjpegTestResult => ({
    latency_ms: Date.now() - started,
    ...partial,
  });
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: basicAuthHeader(credentials),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
    if (!response.ok) {
      return result({
        ok: false,
        content_type: contentType,
        error: `The camera answered HTTP ${response.status}${response.status === 401 ? " (check the credentials)" : ""}`,
      });
    }
    if (!contentType?.toLowerCase().includes("multipart/x-mixed-replace")) {
      return result({
        ok: false,
        content_type: contentType,
        error: `Expected multipart/x-mixed-replace, got ${contentType ?? "no content type"}`,
      });
    }
    const boundary = boundaryOf(contentType);
    const marker = Buffer.from(boundary ? `--${boundary.replace(/^--/, "")}` : "--");
    let seen = Buffer.alloc(0);
    let frameFound = false;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      seen = Buffer.concat([seen, chunk]);
      if (seen.includes(marker)) {
        // The `finally` below closes the connection once the iterator is released.
        frameFound = true;
        break;
      }
      if (seen.length > MAX_TEST_BYTES) break;
    }
    if (frameFound) return result({ ok: true, content_type: contentType });
    return result({
      ok: false,
      content_type: contentType,
      error: "The stream ended before the first frame boundary",
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return result({
      ok: false,
      content_type: null,
      error: timedOut
        ? "No frame boundary arrived within 5 seconds"
        : `Could not connect: ${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "unknown error"}`,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Opens the upstream MJPEG stream for the CRM preview proxy. The caller pipes the body to the
 * browser and aborts `signal` when the browser disconnects.
 */
export async function openMjpegStream(
  url: string,
  credentials: CameraCredentials | null,
  signal: AbortSignal,
  options: { connectTimeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(), options.connectTimeoutMs ?? 10_000);
  try {
    return await (options.fetchImpl ?? fetch)(url, {
      headers: basicAuthHeader(credentials),
      signal: AbortSignal.any([signal, connect.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}
