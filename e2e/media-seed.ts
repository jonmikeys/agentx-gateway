import { createServer, type Server } from "node:http";
import { type APIRequestContext, chromium, expect } from "@playwright/test";
import { type MockMjpeg, startMockMjpeg } from "../tests/support/mock-mjpeg";

/**
 * Demo media for `pnpm screenshots`: labelled PNGs, a WebM clip served from a local HTTP server
 * (the external video) and an MJPEG camera, all drawn in a headless browser so no binary
 * fixtures are committed. Seeding is idempotent by name.
 */
export interface MediaSeed {
  close(): Promise<void>;
}

const demoImages: {
  label: string;
  colour: string;
  tags: string;
  description: string;
  enabled?: string;
}[] = [
  {
    label: "Sunset",
    colour: "#d9622b",
    tags: "nature,scenery",
    description: "An orange sunset over the sea. Show for calm moods.",
  },
  { label: "Ocean", colour: "#1f6fb2", tags: "nature,scenery", description: "Blue open water." },
  { label: "Forest", colour: "#2f7d4f", tags: "nature", description: "Green forest canopy." },
  {
    label: "Lobby map",
    colour: "#6b5b95",
    tags: "info,navigation",
    description: "Floor plan of the lobby for directions.",
  },
  {
    label: "Company logo",
    colour: "#444b57",
    tags: "brand",
    description: "Our logo.",
    enabled: "false",
  },
];

async function generateFiles() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const images = await page.evaluate((specs) => {
      return specs.map(({ label, colour }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        context.fillStyle = colour;
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = "rgba(255,255,255,0.92)";
        context.font = "bold 56px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, 320, 180);
        return canvas.toDataURL("image/png").split(",")[1];
      });
    }, demoImages);
    const frames = await page.evaluate(() => {
      const result: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        context.fillStyle = "#1e3a5f";
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = "#f5b942";
        context.fillRect(60 + index * 120, 200, 140, 90);
        context.fillStyle = "white";
        context.font = "bold 40px sans-serif";
        context.fillText("Lobby camera (mock)", 40, 80);
        result.push(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
      }
      return result;
    });
    const webm = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start();
      for (let index = 0; index < 20; index += 1) {
        context.fillStyle = "#7a3b8f";
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = "white";
        context.font = "bold 56px sans-serif";
        context.textAlign = "center";
        context.fillText("Promo clip", 320, 160 + (index % 5) * 6);
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    return {
      images: images.map((base64) => Buffer.from(base64, "base64")),
      frames: frames.map((base64) => Buffer.from(base64, "base64")),
      webm: Buffer.from(webm, "base64"),
    };
  } finally {
    await browser.close();
  }
}

export async function seedMediaAndCameras(
  admin: APIRequestContext,
  ports: { mjpeg: number; video: number },
): Promise<MediaSeed> {
  const files = await generateFiles();
  const camera: MockMjpeg = await startMockMjpeg({
    port: ports.mjpeg,
    frames: files.frames,
    frameIntervalMs: 250,
    auth: { username: "viewer", password: "demo-camera-password" },
  });
  const videoServer: Server = createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "video/webm",
      "Content-Length": files.webm.length,
    });
    response.end(request.method === "HEAD" ? undefined : files.webm);
  });
  await new Promise<void>((resolve) => videoServer.listen(ports.video, "127.0.0.1", resolve));

  const names = async (collection: string) =>
    new Set(
      (
        ((await (await admin.get(`/api/admin/${collection}`)).json()).data ?? []) as {
          name: string;
        }[]
      ).map((item) => item.name),
    );

  const knownMedia = await names("media");
  for (const [index, image] of demoImages.entries()) {
    if (knownMedia.has(image.label)) continue;
    const response = await admin.post("/api/admin/media/upload", {
      multipart: {
        name: image.label,
        description: image.description,
        tags: image.tags,
        ...(image.enabled ? { enabled: image.enabled } : {}),
        file: { name: `${image.label}.png`, mimeType: "image/png", buffer: files.images[index] },
      },
    });
    expect(response.status()).toBe(201);
  }
  if (!knownMedia.has("Promo clip")) {
    const response = await admin.post("/api/admin/media", {
      data: {
        name: "Promo clip",
        description: "A short promo video hosted elsewhere.",
        tags: ["brand", "video"],
        external_url: `http://127.0.0.1:${ports.video}/promo.webm`,
      },
    });
    expect(response.status()).toBe(201);
  }

  const knownCameras = await names("cameras");
  if (!knownCameras.has("Look-at sidecar")) {
    const response = await admin.post("/api/admin/cameras", {
      data: {
        type: "lookat_sidecar",
        name: "Look-at sidecar",
        description: "The RealSense look-at provider feed configured in the Unity app.",
      },
    });
    expect(response.status()).toBe(201);
  }
  if (!knownCameras.has("Lobby camera")) {
    const response = await admin.post("/api/admin/cameras", {
      data: {
        type: "mjpeg_url",
        name: "Lobby camera",
        description: "Wide shot of the lobby entrance.",
        url: camera.streamUrl,
        credentials: { username: "viewer", password: "demo-camera-password" },
      },
    });
    expect(response.status()).toBe(201);
  }

  return {
    close: async () => {
      await camera.close();
      await new Promise((resolve) => videoServer.close(resolve));
    },
  };
}
