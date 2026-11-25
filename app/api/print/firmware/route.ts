import { NextRequest, NextResponse } from "next/server";
import { isDeviceId } from "@/lib/link-code";
import { RELEASE_PLANS, firmwareReply, pickFirmware, productOf } from "@/lib/printers/eatabit-firmware";

export const dynamic = "force-dynamic";

/**
 * POST /api/print/firmware   (form-encoded, plain-text reply - the printer is an ESP32)
 *
 *   Device=pfd-eatabit-<mac>&Version=2.9.0              ->  update=none
 *   Device=pfd-orderbox-<mac>&Product=orderbox&Version=1.0.0   (order box)
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
  const product = productOf(form.get("Product"), device);
  if (!product) return text("update=none");
  const release = pickFirmware(RELEASE_PLANS[product], device, version);
  if (release) console.log(`firmware: offering ${product} ${release.version} to ${device} (on ${version})`);
  return text(firmwareReply(release, req.nextUrl.origin, product));
}

function text(body: string, status = 200) {
  return new NextResponse(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
