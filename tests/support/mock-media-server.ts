import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { makeMp4, makePng } from "./media-files";

/**
 * Serves files for the external-URL checks: good and bad content types, a server that refuses
 * HEAD, redirect chains, a declared-huge video and a server that never answers.
 *   /pic.png            image/png (HEAD and GET)
 *   /clip.mp4           video/mp4, 4 KB
 *   /page.html          text/html (not allowed)
 *   /no-head.png        HEAD answers 405, ranged GET answers 206 with Content-Range
 *   /huge.mp4           HEAD declares 300 MB (over the video limit)
 *   /hop/<n>            redirects n more times, then to /pic.png
 *   /hang               never answers
 *   /missing            404
 */
export interface MockMediaServer {
  url: string;
  close(): Promise<void>;
}

export async function startMockMediaServer(): Promise<MockMediaServer> {
  const png = makePng(8, 8, [20, 140, 90]);
  const mp4 = makeMp4(4000);
  const sockets = new Set<Socket>();

  const send = (
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
    contentType: string,
    declaredLength = body.length,
  ) => {
    response.writeHead(200, { "Content-Type": contentType, "Content-Length": declaredLength });
    response.end(request.method === "HEAD" ? undefined : body);
  };

  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    const hop = /^\/hop\/(\d+)$/.exec(path);
    if (hop) {
      const remaining = Number(hop[1]);
      response.writeHead(302, { Location: remaining > 0 ? `/hop/${remaining - 1}` : "/pic.png" });
      response.end();
    } else if (path === "/pic.png") {
      send(request, response, png, "image/png");
    } else if (path === "/clip.mp4") {
      send(request, response, mp4, "video/mp4");
    } else if (path === "/page.html") {
      send(request, response, Buffer.from("<html></html>"), "text/html; charset=utf-8");
    } else if (path === "/huge.mp4") {
      send(request, response, mp4, "video/mp4", 300 * 1024 * 1024);
    } else if (path === "/no-head.png") {
      if (request.method === "HEAD") {
        response.writeHead(405).end();
      } else {
        response.writeHead(206, {
          "Content-Type": "image/png",
          "Content-Range": `bytes 0-0/${png.length}`,
          "Content-Length": 1,
        });
        response.end(png.subarray(0, 1));
      }
    } else if (path === "/hang") {
      // Intentionally no response.
    } else {
      response.writeHead(404).end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
