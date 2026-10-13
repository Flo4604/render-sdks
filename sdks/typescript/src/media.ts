export type ImageVariant = "small" | "card" | "zoom";

const originalImage =
  /^https?:\/\/([^/\s\\?#]+)\/v1\/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\.(?:webp|png)$/;

/** Build a public derivative URL without fetching or changing the original image. */
export function imageUrl(original: string, variant: ImageVariant): string {
  if (!["small", "card", "zoom"].includes(variant))
    throw new TypeError("Image variant must be small, card, or zoom");
  const match = originalImage.exec(original);
  if (!match || match[1]?.includes("@") || /[\s\x00-\x1f\x7f]/.test(original))
    throw new TypeError(
      "Expected an absolute HTTP(S) original image URL without credentials, query, or fragment",
    );
  const url = new URL(original);
  return `${url.origin}/d/v1/${match[2]}_${variant}.webp`;
}
