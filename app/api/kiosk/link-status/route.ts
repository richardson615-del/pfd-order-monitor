import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isDeviceId, isLinkCode, linkCodeState, mayCollect } from "@/lib/link-code";
import { mayIssueSecretOnLink } from "@/lib/device-binding";
import { hashDeviceSecret, newDeviceSecret } from "@/lib/device-secret";

export const dynamic = "force-dynamic";

/**
 * GET /api/kiosk/link-status?code=123456&device=…[&ref=aid:…]
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
 *
 * `ref` (SH1 / Z-02) is the tablet's device reference, if the shell gave
 * it one. When it is an `aid:` reference the office has already bound to
 * the restaurant this code was linked to, the one `linked` answer also
 * carries `device_secret`: 32 random bytes the tablet keeps and sends on
 * later bootstraps. Only its sha256 is stored (kiosk_devices.secret_hash);
 * it replaces any earlier one, so a tablet that lost its storage and is
 * linked again is whole again. The reference is not a secret and may sit in
 * a query string; the secret travels in this response body and nowhere else.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const device = req.nextUrl.searchParams.get("device");
  const ref = req.nextUrl.searchParams.get("ref");
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

  const deviceSecret = await issueDeviceSecret(admin, ref, claimed.restaurant_id, now);

  return NextResponse.json(
    {
      status: "linked",
      token_hash: claimed.token_hash,
      restaurant: restaurant ? { id: restaurant.id, name: restaurant.name } : null,
      ...(deviceSecret ? { device_secret: deviceSecret } : {}),
    },
    { headers: noStore }
  );
}

/**
 * A fresh secret for the tablet that just collected its link, or null.
 *
 * Who may have one is lib/device-binding.ts's rule (mayIssueSecretOnLink).
 * The hash is written only onto a row STILL bound to that restaurant, and
 * the secret is returned only if that write landed on a row - a secret the
 * bridge did not record would be a tablet that believes it can bootstrap
 * and cannot. Any failure here is "no secret": the link itself already
 * succeeded and must not be lost to this.
 */
async function issueDeviceSecret(
  admin: ReturnType<typeof supabaseAdmin>,
  ref: string | null,
  restaurantId: string | null,
  now: number
): Promise<string | null> {
  try {
    if (!ref || !restaurantId) return null;
    const { data: row } = await admin.from("kiosk_devices").select("restaurant_id").eq("device_ref", ref).maybeSingle();
    if (!mayIssueSecretOnLink(ref, row as { restaurant_id: string | null } | null, restaurantId)) return null;
    const secret = newDeviceSecret();
    const { data: written, error } = await admin
      .from("kiosk_devices")
      .update({ secret_hash: hashDeviceSecret(secret), updated_at: new Date(now).toISOString() })
      .eq("device_ref", ref)
      .eq("restaurant_id", restaurantId)
      .select("device_ref")
      .maybeSingle();
    return !error && written ? secret : null;
  } catch {
    return null;
  }
}

const noStore = { "Cache-Control": "no-store" };
