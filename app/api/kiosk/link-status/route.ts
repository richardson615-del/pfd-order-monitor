import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isDeviceId, isLinkCode, linkCodeState, mayCollect } from "@/lib/link-code";

export const dynamic = "force-dynamic";

/**
 * GET /api/kiosk/link-status?code=123456&device=…
 *
 * "Has the office linked my code yet?" Polled every LINK_STATUS_POLL_MS by
 * the Pairing screen.
 *
 * Answers `pending` / `expired` / `consumed` with nothing else attached.
 * Answers `linked` exactly once, to exactly the device the code was issued
 * to, and that answer carries the magic-link hash the browser turns into a
 * session (supabase.auth.verifyOtp). The row is marked consumed in the same
 * statement that reads it, so two polls racing each other cannot both be
 * handed the token.
 *
 * A code that exists but belongs to another device is a 404, the same as a
 * code that does not exist. Anything more specific confirms codes to
 * somebody guessing them.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const device = req.nextUrl.searchParams.get("device");
  if (!isLinkCode(code) || !isDeviceId(device)) {
    return NextResponse.json({ error: "code and device required" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("kiosk_link_codes")
    .select("code, device_id, expires_at, restaurant_id, linked_at, token_hash, consumed_at")
    .eq("code", code)
    .maybeSingle();
  if (!row || row.device_id !== device) {
    return NextResponse.json({ error: "unknown code" }, { status: 404 });
  }

  const now = Date.now();
  const state = linkCodeState(row, now);
  if (!mayCollect(row, device, now)) {
    return NextResponse.json({ status: state }, { headers: noStore });
  }

  // Claim it. The `is null` guard is the whole race protection: whichever
  // request updates first gets the token; the other sees no row and reports
  // consumed, which is true.
  const { data: claimed } = await admin
    .from("kiosk_link_codes")
    .update({ consumed_at: new Date(now).toISOString() })
    .eq("code", code)
    .is("consumed_at", null)
    .select("token_hash, restaurant_id")
    .maybeSingle();
  if (!claimed?.token_hash) {
    return NextResponse.json({ status: "consumed" }, { headers: noStore });
  }

  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("id", claimed.restaurant_id)
    .maybeSingle();

  return NextResponse.json(
    {
      status: "linked",
      token_hash: claimed.token_hash,
      restaurant: restaurant ? { id: restaurant.id, name: restaurant.name } : null,
    },
    { headers: noStore }
  );
}

const noStore = { "Cache-Control": "no-store" };
