import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { mintTabletSession } from "@/lib/tablet-session";
import {
  BOOTSTRAP_POLL_MS,
  BOOTSTRAP_RATE_WINDOW_MS,
  bootstrapDecision,
  isDeviceRef,
  mayBootstrap,
} from "@/lib/device-binding";

export const dynamic = "force-dynamic";

/**
 * POST /api/kiosk/bootstrap   { device, model? }
 *
 * "I am tablet <device>. Whose orders do I show?"
 *
 * Unauthenticated by necessity - a tablet that has no session yet is the
 * caller - and answered from the bridge's own kiosk_devices table, which
 * the CRM keeps current. Three answers:
 *
 *   bound      the reference is assigned to a restaurant: a magic-link
 *              hash for that restaurant's tablet login, minted now, sent
 *              once. The page verifies it in the browser.
 *   unbound    never assigned (or unassigned). The reference is recorded
 *              with what the tablet said about itself, so the office sees
 *              "new tablet seen 2 min ago" and can assign it; the page
 *              keeps asking every BOOTSTRAP_POLL_MS.
 *   throttled  bound, but a session was minted for it moments ago. Try
 *              again shortly. A reload loop does not mint a session a
 *              second, and neither does somebody replaying a reference.
 *
 * Every bootstrap is logged (kiosk_bootstrap_log, and last_seen_at on the
 * row; last_bootstrap_at and bootstrap_count when a session is minted),
 * and one address is capped per window. A reference the pattern refuses
 * is a 400 and is not stored.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const device = body?.device;
  if (!isDeviceRef(device)) return NextResponse.json({ error: "device reference required" }, { status: 400 });
  const model = typeof body?.model === "string" ? body.model.slice(0, 120) : null;
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;

  const admin = supabaseAdmin();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const ip = clientIp(req);

  const { count } = await admin
    .from("kiosk_bootstrap_log")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("at", new Date(now - BOOTSTRAP_RATE_WINDOW_MS).toISOString());
  if (!mayBootstrap(count ?? 0)) {
    return NextResponse.json({ error: "too many requests from this address" }, { status: 429, headers: noStore });
  }
  await admin.from("kiosk_bootstrap_log").insert({ device_ref: device, ip, at: nowIso });

  const { data: row } = await admin
    .from("kiosk_devices")
    .select("device_ref, restaurant_id, last_bootstrap_at, bootstrap_count")
    .eq("device_ref", device)
    .maybeSingle();

  const decision = bootstrapDecision(row ?? null, now);

  // Seen, whatever the answer. The CRM's "new tablets" list reads this.
  await admin.from("kiosk_devices").upsert(
    {
      device_ref: device,
      last_seen_at: nowIso,
      updated_at: nowIso,
      ...(model ? { model } : {}),
      ...(userAgent ? { user_agent: userAgent } : {}),
    },
    { onConflict: "device_ref" }
  );

  if (decision !== "bound") {
    return NextResponse.json({ status: decision, poll_every_ms: BOOTSTRAP_POLL_MS }, { headers: noStore });
  }

  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("id", row!.restaurant_id!)
    .maybeSingle();
  if (!restaurant) {
    // Bound to a restaurant that no longer exists. Unbound is the honest
    // answer; the office will see it on the list and re-assign.
    return NextResponse.json({ status: "unbound", poll_every_ms: BOOTSTRAP_POLL_MS }, { headers: noStore });
  }

  const minted = await mintTabletSession(restaurant, "bootstrap:" + device.slice(0, 24));
  if ("error" in minted) return NextResponse.json({ error: minted.error }, { status: 502, headers: noStore });

  // bootstrap_count is a tally for a human reading the row, not a counter
  // anything enforces, so read-then-write is fine here.
  await admin
    .from("kiosk_devices")
    .update({ last_bootstrap_at: nowIso, bootstrap_count: (row?.bootstrap_count ?? 0) + 1 })
    .eq("device_ref", device);

  return NextResponse.json(
    {
      status: "bound",
      token_hash: minted.token_hash,
      restaurant: { id: restaurant.id, name: restaurant.name },
    },
    { headers: noStore }
  );
}

const noStore = { "Cache-Control": "no-store" };

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return (first || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}
