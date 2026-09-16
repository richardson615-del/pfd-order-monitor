import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  LINK_CODE_RATE_WINDOW_MS,
  LINK_CODE_TTL_MS,
  LINK_STATUS_POLL_MS,
  generateLinkCode,
  isDeviceId,
  linkCodeState,
  mayCreateLinkCode,
} from "@/lib/link-code";

export const dynamic = "force-dynamic";

/**
 * POST /api/kiosk/link-code   { device }
 *
 * "This tablet has no session. Give me a code the office can link."
 *
 * Unauthenticated by necessity - the whole point is that the caller has
 * no session - and so it does as little as possible: it hands out a
 * six-digit number bound to the device id in the body, and nothing else.
 * The number is useless to anyone but the office (who need CRM access to
 * link it) and the device that asked (the only one that can collect the
 * result). Rate-limited per address so a script cannot fill the table.
 *
 * A device that already holds a pending code gets the same one back rather
 * than a new one. The tablet reloads on every network blip, and a code
 * that changed under the office's fingers mid-phone-call is how "read it
 * to me again" becomes the whole call.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const device = body?.device;
  if (!isDeviceId(device)) {
    return NextResponse.json({ error: "device id required" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const now = Date.now();
  const ip = clientIp(req);

  const { count } = await admin
    .from("kiosk_link_codes")
    .select("code", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", new Date(now - LINK_CODE_RATE_WINDOW_MS).toISOString());
  if (!mayCreateLinkCode(count ?? 0)) {
    return NextResponse.json({ error: "too many codes from this address - try again later" }, { status: 429 });
  }

  // The device's own pending code, if it still has one.
  const { data: existing } = await admin
    .from("kiosk_link_codes")
    .select("code, device_id, expires_at, restaurant_id, linked_at, token_hash, consumed_at")
    .eq("device_id", device)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing && linkCodeState(existing, now) === "pending") {
    return NextResponse.json(reply(existing.code, existing.expires_at));
  }

  // Six digits collide; a primary-key refusal is retried with a fresh
  // number rather than handed to the tablet as an error it cannot act on.
  const expiresAt = new Date(now + LINK_CODE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateLinkCode((n) => Uint8Array.from(randomBytes(n)));
    const { error } = await admin
      .from("kiosk_link_codes")
      .insert({ code, device_id: device, ip, expires_at: expiresAt });
    if (!error) return NextResponse.json(reply(code, expiresAt));
    if (!/duplicate|unique|already exists/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ error: "could not allocate a code - try again" }, { status: 503 });
}

function reply(code: string, expiresAt: string) {
  return { code, expires_at: expiresAt, poll_every_ms: LINK_STATUS_POLL_MS };
}

/** The first hop Vercel reports, or "unknown" - never null, so the rate limit still groups. */
function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return (first || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}
