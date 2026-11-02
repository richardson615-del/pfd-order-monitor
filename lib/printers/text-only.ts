/**
 * PFD's own Eatabit firmware identifies itself in the User-Agent. Its EP-300
 * head is slow on graphics (a logo header takes longer than the ticket is
 * worth to a cook) and the box has no cutter, so those printers get the
 * all-text layout at large scale, with the restaurant name typed in big
 * letters where the raster header would have been. Epson printers are not
 * affected.
 *
 * Lives here, not in app/api/print/epson/route.ts: a route file may export
 * only HTTP handlers and Next's route config, and `next build` fails on
 * anything else (BF1, 2026-11-02).
 */
export function isTextOnlyPrinter(userAgent: string | null): boolean {
  return (userAgent ?? "").startsWith("pfd-eatabit");
}
