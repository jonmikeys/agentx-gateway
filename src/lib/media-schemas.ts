import { z } from "zod";

/** Shared by the admin API, the services and the CRM forms (docs/media-content.md). */

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;

export function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:";
}

function hasEmbeddedCredentials(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  const url = new URL(value);
  return url.username !== "" || url.password !== "";
}

/** An http(s) URL without embedded `user:password@`, which would leak into logs and the catalogue. */
export const httpUrlSchema = z
  .string()
  .trim()
  .min(1, "Enter a URL")
  .max(2048)
  .refine(isHttpUrl, "Must be an absolute http:// or https:// URL")
  .refine(
    (value) => !hasEmbeddedCredentials(value),
    "Do not put credentials in the URL; use the credentials fields",
  );

/** Tags are lowercase, trimmed, whitespace-free and unique. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (tag) seen.add(tag);
  }
  return [...seen];
}

export const tagsSchema = z
  .array(z.string().max(MAX_TAG_LENGTH * 2))
  .max(MAX_TAGS * 2)
  .transform(normalizeTags)
  .pipe(
    z
      .array(
        z
          .string()
          .max(MAX_TAG_LENGTH, `Tags are at most ${MAX_TAG_LENGTH} characters`)
          .regex(/^[^,]+$/, "Tags cannot contain commas"),
      )
      .max(MAX_TAGS, `At most ${MAX_TAGS} tags`),
  );

const nameSchema = z.string().trim().min(1, "Enter a name").max(120);
const descriptionSchema = z.string().trim().max(1000);

export const mediaExternalCreateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default(""),
  tags: tagsSchema.default([]),
  enabled: z.boolean().default(true),
  external_url: httpUrlSchema,
});

export const mediaUpdateSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  tags: tagsSchema.optional(),
  enabled: z.boolean().optional(),
});

export type MediaExternalCreateInput = z.infer<typeof mediaExternalCreateSchema>;
export type MediaUpdateInput = z.infer<typeof mediaUpdateSchema>;

export const mediaQuerySchema = z.object({
  kind: z.enum(["image", "video"]).optional(),
  tag: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  enabled: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

export type MediaQuery = z.infer<typeof mediaQuerySchema>;

/** Camera types the gateway can serve today. `rtsp_via_relay` is reserved (docs/media-content.md). */
export const CAMERA_TYPES = ["lookat_sidecar", "mjpeg_url"] as const;
export type CameraType = (typeof CAMERA_TYPES)[number];

export const cameraCredentialsSchema = z.object({
  username: z.string().min(1, "Enter a username").max(200),
  password: z.string().min(1, "Enter a password").max(500),
});

const cameraBase = {
  name: nameSchema,
  description: descriptionSchema.default(""),
  enabled: z.boolean().default(true),
};

/**
 * Open union on `type`: unknown types are rejected on write but tolerated on read (the column is
 * plain text), so a future `rtsp_via_relay` only needs a new member here.
 */
export const cameraInputSchema = z.discriminatedUnion("type", [
  z.object({ ...cameraBase, type: z.literal("lookat_sidecar") }),
  z.object({
    ...cameraBase,
    type: z.literal("mjpeg_url"),
    url: httpUrlSchema,
    credentials: cameraCredentialsSchema.nullable().optional(),
  }),
]);

export type CameraInput = z.infer<typeof cameraInputSchema>;

/** Partial update. `credentials` absent keeps the stored value, `null` clears it. */
export const cameraUpdateSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  enabled: z.boolean().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
  credentials: cameraCredentialsSchema.nullable().optional(),
});

export type CameraUpdateInput = z.infer<typeof cameraUpdateSchema>;

export const cameraReorderSchema = z.object({ ids: z.array(z.string()).min(1) });
