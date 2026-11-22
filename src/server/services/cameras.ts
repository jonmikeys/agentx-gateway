import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { type CameraInput, type CameraUpdateInput, cameraInputSchema } from "@/lib/media-schemas";
import { decryptSecret, encryptSecret } from "@/server/crypto/secrets";
import { getDb } from "@/server/db/client";
import { cameras } from "@/server/db/schema";
import type { CameraCredentials } from "@/server/media/mjpeg";
import { ServiceError } from "@/server/services/errors";

type CameraRow = typeof cameras.$inferSelect;

export function newCameraId(): string {
  return `cam_${randomBytes(6).toString("hex")}`;
}

/** Hides most of a username: `viewer` becomes `v••••r`. Never reveals short names. */
export function maskUsername(username: string): string {
  if (username.length <= 2) return "••";
  return `${username[0]}${"•".repeat(Math.min(username.length - 2, 6))}${username.at(-1)}`;
}

/** Admin-facing camera. Credentials are write-only: a masked username only, never the password. */
export interface CameraView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  type: string;
  url: string | null;
  credentials: { username_masked: string; has_password: true } | null;
  /** True when the CRM can test and preview this camera through the gateway. */
  previewable: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Catalogue entry returned to Unity by `GET /v1/cameras`. */
export interface CameraCatalogueEntry {
  id: string;
  name: string;
  description: string;
  type: string;
  url?: string;
  credentials?: CameraCredentials;
}

function configUrl(row: CameraRow): string | null {
  return typeof row.config.url === "string" ? row.config.url : null;
}

function decryptCredentials(row: CameraRow): CameraCredentials | null {
  return row.credentials ? (JSON.parse(decryptSecret(row.credentials)) as CameraCredentials) : null;
}

export function toCameraView(row: CameraRow): CameraView {
  const credentials = decryptCredentials(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    type: row.type,
    url: configUrl(row),
    credentials: credentials
      ? { username_masked: maskUsername(credentials.username), has_password: true }
      : null,
    previewable: row.type === "mjpeg_url",
    sort_order: row.sortOrder,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toCameraCatalogueEntry(row: CameraRow): CameraCatalogueEntry {
  const entry: CameraCatalogueEntry = {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
  };
  const url = configUrl(row);
  if (url) entry.url = url;
  const credentials = decryptCredentials(row);
  if (credentials) entry.credentials = credentials;
  return entry;
}

export async function listCameras(): Promise<CameraRow[]> {
  return getDb().select().from(cameras).orderBy(asc(cameras.sortOrder), asc(cameras.createdAt));
}

export async function listEnabledCameras(): Promise<CameraRow[]> {
  return getDb()
    .select()
    .from(cameras)
    .where(eq(cameras.enabled, true))
    .orderBy(asc(cameras.sortOrder), asc(cameras.createdAt));
}

export async function findCamera(id: string): Promise<CameraRow> {
  const [row] = await getDb().select().from(cameras).where(eq(cameras.id, id));
  if (!row) throw new ServiceError(404, "camera_not_found", "Camera not found");
  return row;
}

/** A camera with its decrypted credentials, for connection tests and the preview proxy only. */
export async function getCameraRuntime(
  id: string,
): Promise<{ row: CameraRow; url: string | null; credentials: CameraCredentials | null }> {
  const row = await findCamera(id);
  return { row, url: configUrl(row), credentials: decryptCredentials(row) };
}

function validationError(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const first = issues[0];
  return new ServiceError(
    400,
    "validation_error",
    first ? `${first.path || "body"}: ${first.message}` : "Invalid camera",
    issues,
  );
}

function configFor(input: CameraInput): Record<string, unknown> {
  return input.type === "mjpeg_url" ? { url: input.url } : {};
}

function credentialsFor(input: CameraInput): string | null {
  return input.type === "mjpeg_url" && input.credentials
    ? encryptSecret(JSON.stringify(input.credentials))
    : null;
}

export async function createCamera(input: CameraInput): Promise<CameraRow> {
  const db = getDb();
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${cameras.sortOrder}), -1) + 1` })
    .from(cameras);
  const [row] = await db
    .insert(cameras)
    .values({
      id: newCameraId(),
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      type: input.type,
      config: configFor(input),
      credentials: credentialsFor(input),
      sortOrder: Number(next),
    })
    .returning();
  return row;
}

/** Merges the changes into the stored camera and re-validates the whole thing. */
export async function updateCamera(id: string, input: CameraUpdateInput): Promise<CameraRow> {
  const current = await findCamera(id);
  const type = input.type ?? current.type;
  const stored = decryptCredentials(current);
  const credentials = input.credentials === undefined ? stored : input.credentials;
  const merged = {
    name: input.name ?? current.name,
    description: input.description ?? current.description,
    enabled: input.enabled ?? current.enabled,
    type,
    url: input.url ?? configUrl(current) ?? undefined,
    credentials,
  };
  const parsed = cameraInputSchema.safeParse(merged);
  if (!parsed.success) throw validationError(parsed.error);

  const [row] = await getDb()
    .update(cameras)
    .set({
      name: parsed.data.name,
      description: parsed.data.description,
      enabled: parsed.data.enabled,
      type: parsed.data.type,
      config: configFor(parsed.data),
      credentials: credentialsFor(parsed.data),
      updatedAt: new Date(),
    })
    .where(eq(cameras.id, id))
    .returning();
  return row;
}

export async function deleteCamera(id: string): Promise<void> {
  await findCamera(id);
  await getDb().delete(cameras).where(eq(cameras.id, id));
}

/** Sets `sort_order` to each id's position. Ids not listed keep their relative order after them. */
export async function reorderCameras(ids: string[]): Promise<CameraRow[]> {
  const existing = await listCameras();
  const known = new Set(existing.map((camera) => camera.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0 || new Set(ids).size !== ids.length) {
    throw new ServiceError(400, "invalid_order", "The order must list each existing camera once");
  }
  const order = [...ids, ...existing.map((camera) => camera.id).filter((id) => !ids.includes(id))];
  await getDb().transaction(async (tx) => {
    for (const [position, id] of order.entries()) {
      await tx.update(cameras).set({ sortOrder: position }).where(eq(cameras.id, id));
    }
  });
  return listCameras();
}
