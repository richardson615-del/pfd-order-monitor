import { NextRequest, NextResponse } from "next/server";
import { isWellFormedCode, normalizePhone } from "@/lib/partner-app";
import { UUID_RE } from "@/lib/restaurant-ref";
import { verifyLoginCode } from "@/lib/partner-app-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/app/verify { phone, code, restaurant_id? } -> an app session (PA1).
 * 409 { choose: [{id, name}] } when the phone is on file for more than one
 * restaurant; the app asks which and sends the same code again with restaurant_id.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) ?? {};
  const phone = normalizePhone(body.phone);
  if (!phone || !isWellFormedCode(body.code)) return NextResponse.json({ error: "Enter the 6-digit code from the text." }, { status: 400 });
  const restaurantId = typeof body.restaurant_id === "string" && UUID_RE.test(body.restaurant_id) ? body.restaurant_id : null;
  const r = await verifyLoginCode(phone, body.code.trim(), restaurantId);
  if ("error" in r) return NextResponse.json({ error: r.error, ...(r.choose ? { choose: r.choose } : {}) }, { status: r.status });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
