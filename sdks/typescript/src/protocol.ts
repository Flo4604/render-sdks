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

export const Failure = z.strictObject({ code: z.string(), detail: z.string() });

export const ImageUrls = z.partialRecord(View, z.url());
export type ImageUrls = z.infer<typeof ImageUrls>;
export const RenderData = z.union([
  z.strictObject({ id: RenderId, images: ImageUrls }),
  z.strictObject({
    id: RenderId,
    status: z.enum(["queued", "rendering", "processing"]),
  }),
  z.strictObject({ id: RenderId, status: z.literal("failed"), error: Failure }),
]);
export type RenderData = z.infer<typeof RenderData>;
export const ResponseMeta = z.strictObject({ requestId: z.string().min(1) });
export const RenderEnvelope = z.strictObject({
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
export const RenderBatchEnvelope = z.strictObject({
  meta: ResponseMeta,
  data: z.strictObject({ renders: z.array(RenderData.nullable()) }),
});
