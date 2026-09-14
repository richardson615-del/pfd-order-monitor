/**
 * Generates every app icon from one definition.
 *
 * The launcher icon, the maskable icon, the notification icon and the
 * notification badge all have to be the same mark. They were previously four
 * hand-made PNGs of a blue "PFD" square, which meant the tablet's home screen
 * said one thing and the app said another - and now says "Premium".
 *
 * Reproducible on purpose: re-run this, commit the output, and the icons
 * cannot drift from components/Brand.tsx's Monogram. Run with:
 *
 *   npx tsx scripts/build-icons.ts
 *
 * NOT part of `npm run build` - it writes into public/ and CI has no business
 * committing binaries. The Android launcher icon is baked into the APK, so a
 * change here also needs an APK rebuild (see android/twa-manifest.json).
 */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Kept in step with --brand / --brand-2 in app/globals.css by hand: canvas cannot read CSS variables. */
const BRAND = "#38bdf8";
const BRAND_2 = "#7dd3fc";
/** The ground the mark sits on, matching --bg so the icon has no seam against a dark launcher. */
const INK = "#04121b";

const OUT = (name: string) => fileURLToPath(new URL(`../public/icons/${name}`, import.meta.url));

/**
 * The "P" tile.
 *
 * `bleed` fills the whole square rather than rounding it - Android's maskable
 * icons are cropped to whatever shape the launcher uses, and a rounded icon
 * inside a circular mask loses its corners twice.
 */
function tile(size: number, { bleed = false }: { bleed?: boolean } = {}) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, BRAND);
  gradient.addColorStop(1, BRAND_2);

  ctx.fillStyle = gradient;
  if (bleed) {
    ctx.fillRect(0, 0, size, size);
  } else {
    const r = size * 0.25;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, r);
    ctx.fill();
  }

  // Maskable icons keep their content inside the middle 80%, or a circular
  // launcher crops the letter.
  const scale = bleed ? 0.52 : 0.65;
  ctx.fillStyle = INK;
  ctx.font = `800 ${Math.round(size * scale)}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("P", size / 2, size * 0.54);

  return canvas.toBuffer("image/png");
}

/**
 * The notification badge.
 *
 * Android draws this as a silhouette in the status bar - it keeps the alpha
 * channel and throws the colour away. So it is drawn white on transparent; a
 * gradient here would come out as a solid blob.
 */
function badge(size: number) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.font = `800 ${Math.round(size * 0.78)}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("P", size / 2, size * 0.54);
  return canvas.toBuffer("image/png");
}

const written: string[] = [];
function write(name: string, buffer: Buffer) {
  writeFileSync(OUT(name), buffer);
  written.push(`${name} (${(buffer.length / 1024).toFixed(1)} kB)`);
}

write("icon-192.png", tile(192));
write("icon-512.png", tile(512));
write("icon-512-maskable.png", tile(512, { bleed: true }));
write("badge-96.png", badge(96));

console.log("Wrote:");
for (const line of written) console.log(`  ${line}`);
console.log("\nThe Android launcher icon is baked into the APK - rebuild it if this changed.");
