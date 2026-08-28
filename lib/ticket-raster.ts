import { createCanvas, Canvas, SKRSContext2D, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { join } from "path";
import QRCode from "qrcode";

/**
 * Raster header/footer blocks for the kitchen ticket.
 *
 * The TM-m30III prints bitmaps through ePOS-Print's <image> element, so the
 * parts of a ticket that want to look designed - logo, banner, footer card -
 * can be drawn rather than assembled from text attributes. The ORDER BODY
 * stays as text on purpose: it is the part that must survive a font being
 * missing, wrap correctly at any width, and print fast under load.
 *
 * 576 dots is the full printable width of an 80mm head at 203dpi.
 */

export const PAPER_WIDTH = 576;

/** Footer copy when a restaurant has set none. */
export const DEFAULT_FOOTER_TEXT_MARK = "Thanks for your order";

/** Per-restaurant design, stored on the restaurant row. */
export interface TicketDesign {
  /** Named direction; controls typography and rule treatment. */
  style?: "classic" | "bold" | "editorial" | null;
  /** Absolute URL of a logo. Dithered to mono at print time. */
  logoUrl?: string | null;
  footerText?: string | null;
  footerUrl?: string | null;
}

interface StyleTokens {
  displayFont: (px: number) => string;
  bodyFont: (px: number) => string;
  nameSize: number;
  bannerHeight: number;
  bannerFill: "solid" | "outline" | "rule";
  letterSpacing: number;
  ruleTop: (ctx: SKRSContext2D, y: number) => number;
}

/**
 * A bundled font, not a system one.
 *
 * Vercel's Linux runtime has no Helvetica or Arial. Naming them would render
 * the header with whatever fallback existed - or with missing glyphs - and
 * the failure would appear on a restaurant's paper, not in any log. Noto Sans
 * (SIL OFL) ships with Next already; we register a copy so local previews and
 * production rasterize identically.
 */
const FONT_FAMILY = "TicketSans";
let fontReady = false;
function ensureFont(): void {
  if (fontReady) return;
  for (const dir of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      if (GlobalFonts.registerFromPath(join(dir, "assets/fonts/TicketSans-Regular.ttf"), FONT_FAMILY)) {
        fontReady = true;
        return;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  // Registering failed - draw with the generic family rather than throwing,
  // since a plain-looking ticket beats no ticket.
  fontReady = true;
}

const FONT_DISPLAY = `${FONT_FAMILY}, sans-serif`;
const FONT_BODY = `${FONT_FAMILY}, sans-serif`;

/**
 * Synthetic bold. The bundled face has one weight, and a kitchen banner needs
 * to be heavier than body text - stroking the glyph outline thickens it
 * predictably instead of relying on a bold face that may not be installed.
 */
function heavy(ctx: SKRSContext2D, on: boolean, px: number): void {
  ctx.lineWidth = on ? Math.max(1, px * 0.055) : 0;
  ctx.lineJoin = "round";
}
function drawGlyph(ctx: SKRSContext2D, ch: string, x: number, y: number, bold: boolean): void {
  ctx.fillText(ch, x, y);
  if (bold) { ctx.strokeStyle = ctx.fillStyle as string; ctx.strokeText(ch, x, y); }
}

function hr(ctx: SKRSContext2D, y: number, h: number, inset = 0): number {
  ctx.fillStyle = "#000";
  ctx.fillRect(inset, y, PAPER_WIDTH - inset * 2, h);
  return y + h;
}

const STYLES: Record<string, StyleTokens> = {
  // Printed-card feel: double hairlines, generous air, restrained type.
  classic: {
    displayFont: (px) => `${px}px ${FONT_BODY}`,
    bodyFont: (px) => `${px}px ${FONT_BODY}`,
    nameSize: 38,
    bannerHeight: 74,
    bannerFill: "outline",
    letterSpacing: 6,
    ruleTop: (ctx, y) => { const a = hr(ctx, y, 3, 24); return hr(ctx, a + 4, 1, 24) + 2; },
  },
  // Loud and unmissable across a pass: heavy display face, solid banner.
  bold: {
    displayFont: (px) => `${px}px ${FONT_DISPLAY}`,
    bodyFont: (px) => `bold ${px}px ${FONT_BODY}`,
    nameSize: 34,
    bannerHeight: 88,
    bannerFill: "solid",
    letterSpacing: 4,
    ruleTop: (ctx, y) => hr(ctx, y, 8) + 2,
  },
  // Quiet and typographic: hairlines, wide tracking, lots of white.
  editorial: {
    displayFont: (px) => `${px}px ${FONT_BODY}`,
    bodyFont: (px) => `${px}px ${FONT_BODY}`,
    nameSize: 30,
    bannerHeight: 66,
    bannerFill: "rule",
    letterSpacing: 12,
    ruleTop: (ctx, y) => hr(ctx, y, 1) + 2,
  },
};

const tokens = (d?: TicketDesign) => STYLES[d?.style || "classic"] ?? STYLES.classic;

/** Width of `text` INCLUDING tracking - measureText alone under-reports it. */
function trackedWidth(ctx: SKRSContext2D, text: string, spacing: number): number {
  const chars = [...text];
  if (!chars.length) return 0;
  return chars.reduce((w, c) => w + ctx.measureText(c).width, 0) + spacing * (chars.length - 1);
}

/** Draws text with manual tracking - canvas has no letterSpacing here. */
function tracked(
  ctx: SKRSContext2D, text: string, cx: number, y: number, spacing: number,
  bold = false
): void {
  let x = cx - trackedWidth(ctx, text, spacing) / 2;
  for (const c of [...text]) {
    drawGlyph(ctx, c, x, y, bold);
    x += ctx.measureText(c).width + spacing;
  }
}

/**
 * Shrinks the font until the tracked line fits, and returns the size used.
 *
 * A fit test that measures without tracking under-reports by spacing x
 * length - on a 30-character restaurant name that is 60+ dots, enough to run
 * off both edges of the paper, which is exactly what it did.
 */
function fitTracked(
  ctx: SKRSContext2D, text: string, font: (px: number) => string,
  startPx: number, spacing: number, maxWidth: number
): number {
  let px = startPx;
  while (px > 12) {
    ctx.font = font(px);
    if (trackedWidth(ctx, text, spacing) <= maxWidth) break;
    px -= 2;
  }
  ctx.font = font(px);
  return px;
}

export interface HeaderInput {
  restaurantName: string;
  orderType: string;
  dueText?: string | null;
  design?: TicketDesign;
  /** Pre-fetched logo bytes, so rendering stays synchronous and offline. */
  logo?: Buffer | null;
  /**
   * Print the restaurant name as well as the logo. Off by default when a
   * logo is present: most logos ARE the name, and printing both spends four
   * lines of a kitchen ticket saying the same thing twice.
   */
  showName?: boolean;
}

export async function renderHeader(input: HeaderInput): Promise<Canvas> {
  ensureFont();
  const t = tokens(input.design);
  // Generous, then cropped to what was actually drawn. Too small a canvas
  // does not error - it silently clips the bottom of the design, which cost
  // the DUE line on the first render.
  const height = 560;
  const canvas = createCanvas(PAPER_WIDTH, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PAPER_WIDTH, height);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  let y = 6;
  y = t.ruleTop(ctx, y);
  y += 20;

  let drewLogo = false;
  if (input.logo) {
    try {
      const img = await loadImage(input.logo);
      // Wider than the old 360: a wordmark is the identity, and shrinking it
      // to a third of the paper wastes the one thing that makes the ticket
      // look like the restaurant's own.
      const maxW = 470, maxH = 150;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      ctx.drawImage(img, Math.round((PAPER_WIDTH - w) / 2), y, w, h);
      y += h + 20;
      drewLogo = true;
    } catch {
      // A logo that will not decode must not cost the kitchen its ticket.
      // Fall through to the name.
    }
  }

  if (!drewLogo || input.showName) {
    ctx.fillStyle = "#000";
    const name = input.restaurantName.toUpperCase();
    const namePx = fitTracked(ctx, name, t.bodyFont, t.nameSize, 2, PAPER_WIDTH - 40);
    tracked(ctx, name, PAPER_WIDTH / 2, y + namePx, 2);
    y += namePx + 22;
  }

  // --- order type banner ---
  const label = input.orderType.toUpperCase();
  const bh = t.bannerHeight;
  // The banner must fit too - DELIVERY is two characters longer than PICKUP
  // and carries the same tracking.
  fitTracked(ctx, label, t.displayFont, Math.round(bh * 0.52), t.letterSpacing, PAPER_WIDTH - 80);
  if (t.bannerFill === "solid") {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, y, PAPER_WIDTH, bh);
    ctx.fillStyle = "#fff";
  } else if (t.bannerFill === "outline") {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.strokeRect(24, y, PAPER_WIDTH - 48, bh);
    ctx.fillStyle = "#000";
  } else {
    hr(ctx, y, 2, 140);
    ctx.fillStyle = "#000";
  }
  heavy(ctx, true, bh * 0.52);
  tracked(ctx, label, PAPER_WIDTH / 2, y + bh * 0.7, t.letterSpacing, true);
  heavy(ctx, false, 0);
  if (t.bannerFill === "rule") hr(ctx, y + bh - 2, 2, 140);
  y += bh + 14;

  if (input.dueText) {
    ctx.fillStyle = "#000";
    ctx.font = t.bodyFont(30);
    heavy(ctx, true, 30);
    tracked(ctx, input.dueText.toUpperCase(), PAPER_WIDTH / 2, y + 26, 1, true);
    heavy(ctx, false, 0);
    y += 40;
  }

  y = hr(ctx, y + 4, 2);
  return crop(canvas, y + 6);
}

export interface FooterInput {
  text: string;
  url?: string | null;
  design?: TicketDesign;
  mark?: string;
}

export async function renderFooter(input: FooterInput): Promise<Canvas> {
  ensureFont();
  const t = tokens(input.design);
  const height = 620;
  const canvas = createCanvas(PAPER_WIDTH, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PAPER_WIDTH, height);

  let y = 8;
  y = t.ruleTop(ctx, y) + 26;

  ctx.fillStyle = "#000";
  ctx.font = t.bodyFont(30);
  for (const line of wrapToWidth(ctx, input.text, PAPER_WIDTH - 70)) {
    tracked(ctx, line, PAPER_WIDTH / 2, y + 26, 1);
    y += 40;
  }
  y += 12;

  if (input.url) {
    const png = await QRCode.toBuffer(input.url, {
      errorCorrectionLevel: "M", margin: 1, width: 240, color: { dark: "#000000", light: "#FFFFFF" },
    });
    const img = await loadImage(png);
    ctx.drawImage(img, Math.round((PAPER_WIDTH - 240) / 2), y, 240, 240);
    y += 240 + 14;
    ctx.fillStyle = "#000";
    ctx.font = t.bodyFont(24);
    tracked(ctx, "SCAN TO ORDER AGAIN", PAPER_WIDTH / 2, y + 20, 3);
    y += 40;
  }

  y += 14;
  hr(ctx, y, 1, 180);
  y += 22;
  ctx.fillStyle = "#000";
  ctx.font = t.bodyFont(20);
  tracked(ctx, input.mark || "POWERED BY PREMIUM FOOD DELIVERY", PAPER_WIDTH / 2, y + 16, 2);
  y += 26;
  ctx.font = t.bodyFont(20);
  tracked(ctx, "PFDWORKS.COM", PAPER_WIDTH / 2, y + 16, 4);
  y += 30;

  return crop(canvas, y);
}

function wrapToWidth(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (ctx.measureText(cand).width > maxW && line) { out.push(line); line = word; }
      else line = cand;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

/** Trims a canvas to the height actually used, so no blank paper is fed. */
function crop(src: Canvas, height: number): Canvas {
  const h = Math.max(1, Math.min(src.height, Math.ceil(height)));
  const out = createCanvas(PAPER_WIDTH, h);
  out.getContext("2d").drawImage(src, 0, 0);
  return out;
}

/**
 * Packs a canvas to 1-bit raster and base64s it for ePOS <image>.
 *
 * Hard threshold by DEFAULT. These blocks are type and line art, whose only
 * greys are anti-aliased edges - dithering those turns clean strokes into
 * speckle at 203dpi. Pass dither=true for a photographic logo, where the
 * opposite is true and a hard threshold turns midtones into black mud.
 */
export function toEposImageXml(canvas: Canvas, dither = false): string {
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const BAYER = [
    [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
  ];
  const rowBytes = Math.ceil(width / 8);
  const bytes = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const limit = dither ? (BAYER[y % 4][x % 4] + 0.5) * (255 / 16) : 128;
      if (lum < limit) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const b64 = Buffer.from(bytes).toString("base64");
  return `<image width="${width}" height="${height}" color="color_1" mode="mono">${b64}</image>`;
}

export const canvasToPng = (c: Canvas): Buffer => c.toBuffer("image/png");
