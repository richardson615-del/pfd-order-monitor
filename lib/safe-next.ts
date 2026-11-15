/**
 * Z-07 (Workstream Z, 2026-11-07): where to land after sign-in - only ever a
 * path on this site.
 *
 * `/login`, `/link` and `/auth/callback` take `next` from the query string.
 * `window.location.assign("javascript:...")` runs script on our origin, and
 * `new URL("https://evil", origin)` or `assign("//evil")` leaves it: an XSS and
 * an open redirect that need no login. Same rule as the CRM's
 * `src/lib/safe-next-path.ts`: a single leading "/" stays on the origin;
 * "//host" and "/\host" do not (browsers read both as scheme-relative).
 * Control characters are refused too, because browsers strip tabs and
 * newlines from a URL, so "/\t/evil" would become "//evil".
 */
export const DEFAULT_NEXT = "/dashboard";

export function safeNext(next: string | null | undefined, fallback = DEFAULT_NEXT): string {
  if (!next || !next.startsWith("/")) return fallback;
  if (next.length > 1 && (next[1] === "/" || next[1] === "\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}
