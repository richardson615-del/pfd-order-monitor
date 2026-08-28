import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * Normalises an uploaded image for a 203dpi mono thermal head.
 *
 * Uploads arrive as whatever someone had - a colour PNG from a designer, a
 * photo of a sign, a screenshot. The printer has 576 dots across and exactly
 * two colours, so the conversion happens ONCE here rather than on every print:
 * the print path should never be doing image processing while a cook waits.
 */

export const MAX_WIDTH = 576;

export type ImageMode = "auto" | "threshold" | "dither";

export interface NormalisedImage {
  base64: string;
  width: number;
  height: number;
  /** Which conversion was actually used - "auto" is resolved, never returned. */
  mode: "threshold" | "dither";
  /** Why, so the CRM can explain the result rather than just showing it. */
  reason: string;
}

/**
 * Line art or photograph?
 *
 * Getting this wrong is very visible: dithering line art turns clean strokes
 * into speckle, and hard-thresholding a photograph turns midtones into black
 * mud. Line art is strongly bimodal - nearly every pixel is at one end of the
 * range - so measuring how much of the image sits in the middle separates the
 * two reliably without anyone having to know the difference.
 */
function looksLikeLineArt(lum: Uint8Array): boolean {
  let mid = 0;
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] > 40 && lum[i] < 215) mid++;
  }
  return mid / lum.length < 0.12;
}

export async function normaliseTicketImage(
  input: Buffer,
  mode: ImageMode = "auto",
  maxWidth = MAX_WIDTH
): Promise<NormalisedImage> {
  const img = await loadImage(input);
  // Only ever scale DOWN. Enlarging a small logo to fill the paper just
  // magnifies its own artefacts.
  const scale = Math.min(maxWidth / img.width, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // White ground: a transparent PNG would otherwise read as black once
  // flattened, and print as a solid rectangle.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const pixels = ctx.getImageData(0, 0, w, h);
  const d = pixels.data;
  const lum = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
  }

  const useDither = mode === "dither" || (mode === "auto" && !looksLikeLineArt(lum));
  const reason =
    mode === "auto"
      ? useDither
        ? "auto: continuous tone detected, dithered"
        : "auto: line art detected, hard threshold"
      : `explicit: ${mode}`;

  const BAYER = [
    [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const limit = useDither ? (BAYER[y % 4][x % 4] + 0.5) * (255 / 16) : 128;
      const v = lum[p] < limit ? 0 : 255;
      const i = p * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);

  return {
    base64: canvas.toBuffer("image/png").toString("base64"),
    width: w,
    height: h,
    mode: useDither ? "dither" : "threshold",
    reason,
  };
}

/** Guards an upload before it is decoded. */
export function decodeUpload(value: unknown): { buffer?: Buffer; error?: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { error: "image must be a base64 string" };
  }
  // Accept a data: URL as well as bare base64 - both are what a browser hands
  // you, and rejecting one is a papercut for whoever writes the console.
  const bare = value.replace(/^data:image\/[a-z+]+;base64,/i, "").trim();
  if (bare.length > 4_000_000) {
    return { error: "image is too large (max ~3MB before encoding)" };
  }
  try {
    const buffer = Buffer.from(bare, "base64");
    if (buffer.length < 32) return { error: "image data is not decodable" };
    return { buffer };
  } catch {
    return { error: "image data is not valid base64" };
  }
}
