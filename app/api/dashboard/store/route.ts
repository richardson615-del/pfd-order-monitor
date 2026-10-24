import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_ZONE, storeSession } from "@/lib/store-session";
import { livePause, readWeek } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/store -> { pause, hours, hours_lines, pushed_at, pending_hours, ordering_channel, timezone }
 *
 * The Store tab's read (migration 052): the live pause (null when none or
 * over), the hours as the CRM last pushed them, and an hours change the
 * restaurant sent that the CRM has not pushed back yet ("Sent to Premium").
 * The restaurant comes from the session; reads use the service role only
 * after that, scoped to that restaurant.
 */
export async function GET() {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const admin = supabaseAdmin();
  const [r, p, sent] = await Promise.all([
    admin.from("restaurants").select("timezone, online_paused_until, online_pause_reason, online_paused_at").eq("id", s.restaurantId).single(),
    admin.from("restaurant_profiles").select("hours, hours_lines, ordering_channel, pushed_at").eq("restaurant_id", s.restaurantId).maybeSingle(),
    admin.from("restaurant_messages").select("created_at, details").eq("restaurant_id", s.restaurantId).eq("kind", "hours_change").eq("direction", "from_restaurant").order("created_at", { ascending: false }).limit(1),
  ]);
  if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  const pushedAt = p.data?.pushed_at ?? null;
  const last = sent.data?.[0];
  const pending = last && (!pushedAt || last.created_at > pushedAt) ? { sent_at: last.created_at, hours: readWeek((last.details as { hours?: unknown } | null)?.hours) } : null;
  return NextResponse.json(
    {
      timezone: r.data.timezone ?? DEFAULT_ZONE,
      pause: livePause(r.data, new Date()),
      hours: readWeek(p.data?.hours),
      hours_lines: p.data?.hours_lines ?? [],
      ordering_channel: p.data?.ordering_channel ?? null,
      pushed_at: pushedAt,
      pending_hours: pending,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
