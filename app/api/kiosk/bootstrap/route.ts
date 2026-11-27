import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { mintTabletSession } from "@/lib/tablet-session";
import { deviceSecretMatches } from "@/lib/device-secret";
import {
  BOOTSTRAP_RATE_WINDOW_MS,
  bootstrapDecision,
  bootstrapWaitReply,
  isDeviceRef,
  kioskRequireSecret,
  mayBootstrap,
} from "@/lib/device-binding";

export const dynamic = "force-dynamic";

/**
 * POST /api/kiosk/bootstrap   { device, secret?, model? }
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
 *              On the wire this is the same body as unbound (SH1): "bound,
 *              but too soon" told a stranger the serial was live.
 *
 * The device secret (SH1 / Z-02, migration 067). The reference is not a
 * secret - it is printed on the tablet. A row with a secret_hash mints only
 * for a caller whose `secret` hashes to it (timing-safe, lib/device-
 * secret.ts); anything else is answered unbound, word for word. A row with
 * no secret_hash behaves as it always did until KIOSK_REQUIRE_SECRET is
 * on, and then it is unbound too. The secret is read from the body, hashed,
 * compared and dropped: never stored, never logged, never echoed.
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

  const row = await readDeviceRow(admin, device);

  const decision = bootstrapDecision(row, now, {
    requireSecret: kioskRequireSecret(),
    secretMatches: deviceSecretMatches(row?.secret_hash, body?.secret),
  });

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

  // Unbound, throttled, no secret, wrong secret: one body, nothing minted.
  if (decision !== "bound") return NextResponse.json(bootstrapWaitReply(), { headers: noStore });

  const restaurant = await findRestaurantByRef<{ id: string; name: string }>(row!.restaurant_id!, "id, name");
  if (!restaurant) {
    // Bound to a restaurant that no longer exists. Unbound is the honest
    // answer; the office will see it on the list and re-assign.
    return NextResponse.json(bootstrapWaitReply(), { headers: noStore });
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

interface DeviceRow {
  device_ref: string;
  restaurant_id: string | null;
  last_bootstrap_at: string | null;
  bootstrap_count: number | null;
  secret_hash?: string | null;
}

/**
 * The row for a reference, with its secret_hash.
 *
 * One fallback, for one error only: the column does not exist (067 not
 * applied yet - migrations are skipped when MIGRATION_DATABASE_URL is
 * unset). No row can hold a secret then, so reading without the column is
 * the old behaviour exactly. Any OTHER failure is "no row" (unbound): a
 * read that failed must never be mistaken for "this row has no secret".
 */
async function readDeviceRow(admin: ReturnType<typeof supabaseAdmin>, device: string): Promise<DeviceRow | null> {
  const withSecret = await admin
    .from("kiosk_devices")
    .select("device_ref, restaurant_id, last_bootstrap_at, bootstrap_count, secret_hash")
    .eq("device_ref", device)
    .maybeSingle();
  if (!withSecret.error) return (withSecret.data as DeviceRow | null) ?? null;
  if (!isMissingSecretColumn(withSecret.error)) return null;
  const legacy = await admin
    .from("kiosk_devices")
    .select("device_ref, restaurant_id, last_bootstrap_at, bootstrap_count")
    .eq("device_ref", device)
    .maybeSingle();
  return legacy.error ? null : ((legacy.data as DeviceRow | null) ?? null);
}

const isMissingSecretColumn = (error: { code?: string; message?: string }): boolean =>
  error.code === "42703" && /secret_hash/.test(error.message ?? "");

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return (first || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}
