import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { makeJpeg } from "./media-files";

/**
 * A tiny MJPEG camera: `GET /stream.mjpg` loops a few JPEG frames as multipart/x-mixed-replace.
 * Also serves `/plain` (text, not a stream), `/missing-boundary` and `/deny` (always 401).
 * Optional Basic auth is enforced on `/stream.mjpg`. Run it by hand with
 * `pnpm exec tsx tests/support/mock-mjpeg.ts` (port from MOCK_MJPEG_PORT, default 4020).
 */
export interface MockMjpegOptions {
  port?: number;
  /** JPEG frames to loop. Defaults to three tiny generated frames. */
  frames?: Buffer[];
  frameIntervalMs?: number;
  auth?: { username: string; password: string };
}

export interface MockMjpeg {
  url: string;
  streamUrl: string;
  /** Authorization headers seen on stream requests. */
  authHeaders: (string | undefined)[];
  close(): Promise<void>;
}

const BOUNDARY = "mockframe";

export async function startMockMjpeg(options: MockMjpegOptions = {}): Promise<MockMjpeg> {
  const frames = options.frames ?? [makeJpeg("frame-0"), makeJpeg("frame-1"), makeJpeg("frame-2")];
  const interval = options.frameIntervalMs ?? 100;
  const sockets = new Set<Socket>();
  const authHeaders: (string | undefined)[] = [];

  const server: Server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    if (path === "/plain") {
      response.writeHead(200, { "Content-Type": "text/plain" }).end("not a stream");
      return;
    }
    if (path === "/deny") {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="camera"' }).end();
      return;
    }
    if (path !== "/stream.mjpg" && path !== "/missing-boundary") {
      response.writeHead(404).end();
      return;
    }
    authHeaders.push(request.headers.authorization);
    if (options.auth) {
      const expected = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString("base64")}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="camera"' }).end();
        return;
      }
    }
    if (path === "/missing-boundary") {
      // Declares a stream but never sends a frame: the connection test must time out.
      response.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      });
      return;
    }
    response.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-cache",
    });
    let index = 0;
    const send = () => {
      const frame = frames[index % frames.length];
      index += 1;
      response.write(
        `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      );
      response.write(frame);
      response.write("\r\n");
    };
    send();
    const timer = setInterval(send, interval);
    response.on("close", () => clearInterval(timer));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/stream.mjpg`,
    authHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1]?.endsWith("mock-mjpeg.ts")) {
  startMockMjpeg({ port: Number(process.env.MOCK_MJPEG_PORT ?? 4020) }).then((camera) =>
    console.log(`Mock MJPEG camera at ${camera.streamUrl}`),
  );
}
