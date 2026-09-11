import { NextRequest, NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/heartbeat
 *
 * "A signed-in dashboard is open for this restaurant right now."
 *
 * It exists because a push subscription survives being signed out - it belongs
 * to the browser's service worker, not the session. So a tablet whose session
 * ended sat on a login screen while push kept reporting delivered and every
 * health check stayed green. This is the only signal that distinguishes a
 * screen somebody is looking at from a dead one.
 *
 * Authenticated by the caller's own session, and the restaurant is taken from
 * that session rather than from the request body. A heartbeat the client could
 * address to any restaurant would let one signed-in device vouch for a tablet
 * on the other side of the state, which is precisely the lie this is meant to
 * detect.
 */
export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const restaurantIds = await getCurrentUserRestaurantIds();
  if (!restaurantIds.length) {
    // Signed in but linked to nothing. Not an error worth shouting about -
    // the dashboard already tells this person to ask PFD to add them.
    return NextResponse.json({ ok: true, recorded: 0 });
  }

  // Trimmed: this is written on every beat and read by a human working out
  // what is on a wall, not parsed.
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin()
    .from("dashboard_heartbeats")
    .upsert(
      restaurantIds.map((restaurant_id) => ({
        restaurant_id,
        last_seen_at: now,
        user_agent: userAgent,
      })),
      { onConflict: "restaurant_id" }
    );

  if (error) {
    // Never fails the caller. A tablet that cannot record a heartbeat is
    // still showing orders, and breaking the dashboard over a monitoring
    // write would turn a reporting gap into an outage.
    console.error("heartbeat not recorded:", error.message);
    return NextResponse.json({ ok: false, recorded: 0 });
  }

  return NextResponse.json({ ok: true, recorded: restaurantIds.length });
}
