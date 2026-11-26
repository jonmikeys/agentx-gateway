import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { makeMp4, makePng } from "./media-files";

/**
 * Media "on the web" for the temporary-item proxy (tests, e2e, screenshots). Paths match the
 * mock SearXNG results when it is started with this server's URL as `mediaBaseUrl`:
 *   /red-panda.png        image/png, honours Range
 *   /red-panda-thumb.png  image/png (the search engine thumbnail)
 *   /missing.png          404 (the proxy falls back to the thumbnail)
 *   /huge.png             declares 30 MB (over the 20 MB image limit)
 *   /vector.svg           image/svg+xml (not a type clients show)
 *   /clip.mp4             video/mp4, 64 KB, honours Range (a resolved video stream)
 *   /expired.mp4          403 (an expired resolved link)
 * Requests are recorded with their Range and Referer headers. Self-contained (no `@/` imports).
 */
export interface RecordedMediaRequest {
  method: string;
  path: string;
  range?: string;
  referer?: string;
  userAgent?: string;
}

export interface MockWebMedia {
  url: string;
  requests: RecordedMediaRequest[];
  png: Buffer;
  thumb: Buffer;
  mp4: Buffer;
  reset(): void;
  close(): Promise<void>;
}

function sendRanged(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
  contentType: string,
): void {
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    ETag: `"mock-${body.length}"`,
  };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(body.length - Number(range[2]), 0);
    const end =
      range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (start >= body.length || end < start) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${body.length}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
      "Content-Length": end - start + 1,
    });
    response.end(request.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": body.length });
  response.end(request.method === "HEAD" ? undefined : body);
}

export async function startMockWebMedia(port = 0): Promise<MockWebMedia> {
  const png = makePng(16, 12, [200, 80, 40]);
  const thumb = makePng(4, 3, [40, 80, 200]);
  const mp4 = makeMp4(64 * 1024);
  const requests: RecordedMediaRequest[] = [];

  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    requests.push({
      method: request.method ?? "GET",
      path,
      range: request.headers.range,
      referer: request.headers.referer,
      userAgent: request.headers["user-agent"],
    });
    if (path === "/red-panda.png") return sendRanged(request, response, png, "image/png");
    if (path === "/red-panda-thumb.png") return sendRanged(request, response, thumb, "image/png");
    if (path === "/clip.mp4") return sendRanged(request, response, mp4, "video/mp4");
    if (path === "/huge.png") {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": 30 * 1024 * 1024 });
      response.end();
      return;
    }
    if (path === "/vector.svg") {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end("<svg xmlns='http://www.w3.org/2000/svg'/>");
      return;
    }
    if (path === "/expired.mp4") {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    requests,
    png,
    thumb,
    mp4,
    reset: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
