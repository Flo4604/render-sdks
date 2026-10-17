// PNG export at a chosen size. The engine returns the view's exact RGBA at
// its compiled resolution; smaller sizes are those pixels downscaled by the
// browser. Sizes above the compiled one are not offered.

import type { Viewer } from "@medalbot/viewer-engine";

export interface ExportSize {
  label: string;
  // Width as a fraction of the compiled width.
  scale: number;
}

export const exportSizes: readonly ExportSize[] = [
  { label: "Full", scale: 1 },
  { label: "Half", scale: 0.5 },
  { label: "Quarter", scale: 0.25 },
];

export async function renderPng(
  viewer: Viewer,
  scale = 1,
  onSize?: (size: { width: number; height: number }) => void,
): Promise<Blob> {
  const pixels = await viewer.renderToPixels();
  onSize?.({ width: pixels.width, height: pixels.height });
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  const source = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);

  if (scale === 1) {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")?.putImageData(source, 0, 0);

    return canvas.convertToBlob({ type: "image/png" });
  }

  const bitmap = await createImageBitmap(source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();

  return canvas.convertToBlob({ type: "image/png" });
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
