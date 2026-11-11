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

/**
 * What an Eatabit's poll writes to `print_devices.printer_name` (2026-11-11),
 * so ingest can tell a restaurant's paper goes to an Eatabit without a schema
 * change: "PFD Eatabit" plus the firmware version when the User-Agent carries
 * one ("pfd-eatabit/2.5.0" -> "PFD Eatabit 2.5.0"). The CRM shows it as the
 * device's model. Null for anything that is not our firmware.
 */
export const EATABIT_PRINTER_NAME = "PFD Eatabit";

export function eatabitPrinterName(userAgent: string | null): string | null {
  if (!isTextOnlyPrinter(userAgent)) return null;
  const version = (userAgent ?? "").match(/^pfd-eatabit\/([0-9][0-9A-Za-z.\-]{0,20})/)?.[1];
  return version ? `${EATABIT_PRINTER_NAME} ${version}` : EATABIT_PRINTER_NAME;
}

export function isEatabitPrinterName(printerName: string | null | undefined): boolean {
  return (printerName ?? "").startsWith(EATABIT_PRINTER_NAME);
}
