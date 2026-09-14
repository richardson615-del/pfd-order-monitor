/**
 * The Premium mark.
 *
 * Restaurants know this company as Premium. "PFD" is internal shorthand and
 * had leaked onto every screen a restaurant ever sees - the login page, the
 * installed app's name, the icon on the tablet's home screen, the
 * notification that wakes the kitchen. This is the one place that word is
 * drawn, so it cannot drift between them again.
 *
 * Drawn in code rather than shipped as an image, deliberately: it has to be
 * crisp from a 24px header to a 512px launcher icon, on a screen somebody is
 * reading across a kitchen. A raster would need five files and would be the
 * wrong one somewhere.
 */

export type BrandSize = "sm" | "md" | "lg";

const WORDMARK_SIZE: Record<BrandSize, number> = { sm: 18, md: 28, lg: 44 };
const MONOGRAM_SIZE: Record<BrandSize, number> = { sm: 26, md: 40, lg: 96 };

/**
 * The gradient both marks are filled with.
 *
 * The id is DERIVED from the props rather than generated. A counter would
 * desync between the server render and the client one - the server process
 * is long-lived, so it hands down `pm-57` while a fresh client render says
 * `pm-1`, and React reports a hydration mismatch on every page carrying the
 * mark. Two marks with the same props share an id, which is harmless: same
 * props mean the same gradient.
 */
function gradient(id: string, onLight: boolean) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor={onLight ? "#0284c7" : "var(--brand)"} />
      <stop offset="100%" stopColor={onLight ? "#0ea5e9" : "var(--brand-2)"} />
    </linearGradient>
  );
}

const gradientId = (kind: string, size: BrandSize, onLight: boolean) =>
  `pm-${kind}-${size}-${onLight ? "light" : "dark"}`;

/**
 * "Premium", optionally with ORDERS beneath it.
 *
 * Set in the brand face at a tight tracking. The sub-label is small caps and
 * widely tracked so it reads as a category rather than as part of the name.
 */
export function Brand({
  size = "md",
  onLight = false,
  withSubtitle = false,
  className,
}: {
  size?: BrandSize;
  onLight?: boolean;
  withSubtitle?: boolean;
  className?: string;
}) {
  const id = gradientId("word", size, onLight);
  const px = WORDMARK_SIZE[size];

  return (
    <span className={`brand ${className ?? ""}`} style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <svg
        height={px}
        viewBox="0 0 320 56"
        role="img"
        aria-label="Premium"
        style={{ display: "block", width: "auto" }}
      >
        <defs>{gradient(id, onLight)}</defs>
        <text
          x="0"
          y="42"
          fill={`url(#${id})`}
          fontFamily="var(--font-brand), system-ui, sans-serif"
          fontSize="48"
          fontWeight="800"
          letterSpacing="-1.6"
        >
          Premium
        </text>
      </svg>
      {withSubtitle && (
        <span
          style={{
            fontFamily: "var(--font-brand), system-ui, sans-serif",
            fontSize: Math.max(9, Math.round(px * 0.3)),
            fontWeight: 700,
            letterSpacing: "0.34em",
            textTransform: "uppercase",
            color: onLight ? "#475569" : "var(--text-dim)",
            paddingLeft: 2,
          }}
        >
          Orders
        </span>
      )}
    </span>
  );
}

/**
 * The "P" tile. Used where the wordmark will not fit, and - via
 * scripts/build-icons.ts - as the single source the launcher and notification
 * icons are generated from, so the tablet's home screen and this header can
 * never show two different marks.
 */
export function Monogram({ size = "md", onLight = false }: { size?: BrandSize; onLight?: boolean }) {
  const id = gradientId("mono", size, onLight);
  const px = MONOGRAM_SIZE[size];

  return (
    <svg width={px} height={px} viewBox="0 0 96 96" role="img" aria-label="Premium" style={{ display: "block" }}>
      <defs>{gradient(id, onLight)}</defs>
      <rect x="0" y="0" width="96" height="96" rx="24" fill={`url(#${id})`} />
      <text
        x="48"
        y="70"
        textAnchor="middle"
        fill={onLight ? "#ffffff" : "#04121b"}
        fontFamily="var(--font-brand), system-ui, sans-serif"
        fontSize="62"
        fontWeight="800"
        letterSpacing="-2"
      >
        P
      </text>
    </svg>
  );
}
