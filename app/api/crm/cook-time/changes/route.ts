import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { supabaseAdmin } from "@/lib/supabase-server";
import { logCursorOf, logLimitOf, readActiveBusy, readCookTimeChanges } from "@/lib/cook-time-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/cook-time/changes[?after=<id>][&since=<ISO>][&restaurant_id=][&limit=]
 * -> { changes, next_after, has_more, active_busy, generated_at }
 *
 * Every cook-time change across all restaurants (or one), oldest first (BT1,
 * migration 058). The same read rides on GET /api/crm/orders?cook_after=<id> for
 * the one-minute sync; this is for anything else, such as the Daily brief's count
 * with `since`. Pass `next_after` back as `after`.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const q = req.nextUrl.searchParams;

  const afterRaw = q.get("after");
  const after = logCursorOf(afterRaw);
  if (afterRaw !== null && after === null) return NextResponse.json({ error: "after must be a whole number, the next_after of the last read", code: "invalid_cursor" }, { status: 400 });

  const sinceRaw = q.get("since");
  if (sinceRaw !== null && Number.isNaN(Date.parse(sinceRaw))) return NextResponse.json({ error: "since must be an ISO time", code: "invalid_since" }, { status: 400 });

  let restaurantId: string | null = null;
  const ref = q.get("restaurant_id");
  if (ref) {
    const r = await findRestaurantByRef<{ id: string }>(ref, "id");
    if (!r) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
    restaurantId = r.id;
  }

  const admin = supabaseAdmin();
  const now = Date.now();
  try {
    const [read, active_busy] = await Promise.all([
      readCookTimeChanges(admin, { after, since: sinceRaw ? new Date(sinceRaw).toISOString() : null, restaurantId, limit: logLimitOf(q.get("limit")) }),
      readActiveBusy(admin, now, restaurantId),
    ]);
    return NextResponse.json({ ...read, active_busy, generated_at: new Date(now).toISOString() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "could not read the cook-time log" }, { status: 500 });
  }
}
