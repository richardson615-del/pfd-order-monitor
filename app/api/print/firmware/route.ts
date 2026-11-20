import { NextRequest, NextResponse } from "next/server";
import { isDeviceId } from "@/lib/link-code";
import { RELEASE_PLAN, firmwareReply, pickFirmware } from "@/lib/printers/eatabit-firmware";

export const dynamic = "force-dynamic";

/**
 * POST /api/print/firmware   (form-encoded, plain-text reply - the printer is an ESP32)
 *
 *   Device=pfd-eatabit-<mac>&Version=2.9.0  ->  update=none
 *                                            or update=2.9.1\nurl=...\nsize=...\nmd5=...
 *
 * Unauthenticated like /api/print/link: the answer is which public .bin to
 * fetch, and the .bin files are public already. No database work.
 */
export async function POST(req: NextRequest) {
  const form = new URLSearchParams(await req.text().catch(() => ""));
  const device = form.get("Device") || "";
  const version = (form.get("Version") || "").trim();
  if (!isDeviceId(device)) return text("error=device id required", 400);
  if (!version) return text("error=version required", 400);
  const release = pickFirmware(RELEASE_PLAN, device, version);
  if (release) console.log(`firmware: offering ${release.version} to ${device} (on ${version})`);
  return text(firmwareReply(release, req.nextUrl.origin));
}

function text(body: string, status = 200) {
  return new NextResponse(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
