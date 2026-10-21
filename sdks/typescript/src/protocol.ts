import { z } from "zod";

export const View = z.enum(["preview", "front", "back"]);
export type View = z.infer<typeof View>;
export const Format = z.enum(["png", "webp"]);
export const Appearance = z.enum(["default", "pattern"]);
export type Appearance = z.infer<typeof Appearance>;

export const RenderId = z
  .string()
  .regex(/^rnd_(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[a-f0-9]{32})$/)
  .brand<"RenderId">();
export const RenderRequest = z.strictObject({
  inspectUrl: z.string().min(1).max(32768),
  views: z
    .array(View)
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length, "Views must be unique")
    .default(["preview", "front", "back"]),
  format: Format.default("webp"),
  appearance: Appearance.optional(),
  statTrak: z.int().min(0).max(999999).optional(),
});
export type RenderRequest = z.output<typeof RenderRequest>;
export type RenderInput = z.input<typeof RenderRequest>;

// Response schemas use z.object so a field the API adds later is ignored rather than
// rejected. The SDK still validates every field it reads.
export const Failure = z.object({ code: z.string(), detail: z.string() });

export const ImageUrls = z.partialRecord(View, z.url());
export type ImageUrls = z.infer<typeof ImageUrls>;
// One link per requested view, final at admission. A finished view's link equals its
// image URL; a pending view's link is a render link the media edge serves once the
// image exists. Present when the request sends `Prefer: links`, or by default once the
// API enables links for every response.
export const ImageLinks = z.partialRecord(View, z.url());
export type ImageLinks = z.infer<typeof ImageLinks>;
export const RenderData = z.union([
  z.object({ id: RenderId, images: ImageUrls, links: ImageLinks.optional() }),
  z.object({
    id: RenderId,
    status: z.enum(["queued", "rendering", "processing"]),
    links: ImageLinks.optional(),
  }),
  z.object({ id: RenderId, status: z.literal("failed"), error: Failure }),
]);
export type RenderData = z.infer<typeof RenderData>;
export const ResponseMeta = z.object({ requestId: z.string().min(1) });
export const RenderEnvelope = z.object({
  meta: ResponseMeta,
  data: RenderData,
});
export const ErrorEnvelope = z.object({
  meta: ResponseMeta,
  error: z.object({
    code: z.string(),
    detail: z.string(),
    status: z.int(),
    title: z.string(),
    type: z.string(),
  }),
});
export const RenderBatchEnvelope = z.object({
  meta: ResponseMeta,
  data: z.object({ renders: z.array(RenderData.nullable()) }),
});
