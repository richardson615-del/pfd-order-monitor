import { NextRequest, NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { minShellVersion } from "@/lib/app-update";
import { HEARTBEAT_MIN_INTERVAL_MS } from "@/lib/kiosk";

export const dynamic = "force-dynamic";

/** The gate states the dashboard can report (lib/alert-gate.ts AlertGateState); the column's CHECK matches. */
const ALERT_STATES: ReadonlySet<unknown> = new Set(["hidden", "ask", "blocked", "unsupported"]);

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

  /**
   * Whether the screen that sent this beat can actually ring (migration 030).
   *
   * Taken from the body rather than inferred: only the browser knows whether
   * its service worker holds a subscription right now. Anything that is not
   * an explicit boolean is recorded as null - "has not told us" - because an
   * older client that never sends the field must not be written down as
   * having alerts off.
   */
  const body = await req.json().catch(() => null);
  const pushSubscribed = typeof body?.pushSubscribed === "boolean" ? body.pushSubscribed : null;

  // Which Android shell this screen runs in (migration 033). Same rule as
  // push_subscribed: only an explicit, sane integer is recorded; anything
  // else is null, "has not said", never "zero".
  const shellVersion =
    Number.isInteger(body?.shellVersion) && body.shellVersion > 0 && body.shellVersion < 1_000_000_000
      ? (body.shellVersion as number)
      : null;

  // Why the screen cannot ring, when it cannot (migration 037). Only one of
  // the gate's own four words is recorded; anything else is null, "has not
  // said". "blocked" on a kiosk is the office's problem - the Hexnode
  // notification policy is missing - and this is how the office finds out.
  const alertState = ALERT_STATES.has(body?.alertState) ? (body.alertState as string) : null;

  // Once a minute per restaurant is plenty (the client beats every two).
  // Anything faster is a bug or abuse, and at five hundred tablets a
  // runaway beat loop is the difference between a quiet database and a
  // busy one. 429, and the client treats it as "the server already has a
  // fresh beat" - which is true.
  const { data: recent } = await supabaseAdmin()
    .from("dashboard_heartbeats")
    .select("restaurant_id, last_seen_at")
    .in("restaurant_id", restaurantIds);
  const cutoff = Date.now() - HEARTBEAT_MIN_INTERVAL_MS;
  const tooSoon = (recent ?? []).every((r: any) => new Date(r.last_seen_at).getTime() > cutoff) && (recent ?? []).length === restaurantIds.length;
  if (tooSoon) {
    return NextResponse.json({ ok: false, recorded: 0, rate_limited: true, ...serving() }, { status: 429 });
  }

  const { error } = await supabaseAdmin()
    .from("dashboard_heartbeats")
    .upsert(
      restaurantIds.map((restaurant_id) => ({
        restaurant_id,
        last_seen_at: now,
        user_agent: userAgent,
        push_subscribed: pushSubscribed,
        shell_version: shellVersion,
        alert_state: alertState,
      })),
      { onConflict: "restaurant_id" }
    );

  if (error) {
    // Never fails the caller. A tablet that cannot record a heartbeat is
    // still showing orders, and breaking the dashboard over a monitoring
    // write would turn a reporting gap into an outage.
    console.error("heartbeat not recorded:", error.message);
    return NextResponse.json({ ok: false, recorded: 0, ...serving() });
  }

  return NextResponse.json({ ok: true, recorded: restaurantIds.length, ...serving() });
}

/**
 * What deployment answered, on the beat the tablet already sends. The
 * dashboard used to ask /api/version separately on the same cadence; one
 * request that says both is one fewer thing to reason about, and a beat
 * that failed to record still tells the tablet whether it is stale.
 */
function serving() {
  return {
    buildId: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
    minShellVersion: minShellVersion(),
  };
}
