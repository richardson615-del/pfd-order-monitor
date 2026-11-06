import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_ZONE, storeSession } from "@/lib/store-session";
import { prepMinutesOf } from "@/lib/countdown";
import { BUSY_SELECT, COOK_LIMIT_SELECT, boostStartLog, busyEndsAt, cookLimitsOf, liveBusy, nextCloseAt, parseBusyRequest } from "@/lib/cook-time";
import { cookSourceOf, endBusy, recordCookTimeChange, sweepExpiredBusy } from "@/lib/cook-time-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/store/busy { minutes, length_minutes } | { end: true } -> { busy, changed }
 *
 * The kitchen's busy boost (BT1, Ticket #948, migration 058). Accept pre-selects
 * default + boost until it ends: at the chosen length or at close, whichever is
 * first. The limits are enforced here (lib/cook-time.ts), per restaurant, and a
 * boost already on cannot be stretched: End it first. The restaurant comes from
 * the session.
 */
export async function POST(req: NextRequest) {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const admin = supabaseAdmin();
  const who = { source: cookSourceOf(req.headers.get("authorization")), actor: s.actor };

  // An expired boost still on the row is logged and cleared first, so it cannot block or be overwritten by this one.
  await sweepExpiredBusy(admin).catch((err) => console.error("busy: sweep failed -", err instanceof Error ? err.message : err));

  const { data: r, error } = await admin.from("restaurants").select(`id, timezone, prep_minutes, ${BUSY_SELECT}, ${COOK_LIMIT_SELECT}`).eq("id", s.restaurantId).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const d = parseBusyRequest(await req.json().catch(() => ({})), cookLimitsOf(r));
  if (d.kind === "error") return NextResponse.json({ error: d.error, code: d.code }, { status: 400 });

  if (d.kind === "end") {
    const ended = await endBusy(admin, r, who);
    if (ended.error) return NextResponse.json({ error: ended.error }, { status: 500 });
    return NextResponse.json({ busy: null, changed: ended.changed });
  }

  const now = new Date();
  if (liveBusy(r, now.getTime())) return NextResponse.json({ error: "Busy is already on. End it first to change it.", code: "busy_already_on" }, { status: 409 });

  const { data: profile } = await admin.from("restaurant_profiles").select("hours").eq("restaurant_id", s.restaurantId).maybeSingle();
  const until = busyEndsAt(now, d.lengthMinutes, nextCloseAt(profile?.hours, now, r.timezone ?? DEFAULT_ZONE)).toISOString();

  const { data: started, error: upErr } = await admin
    .from("restaurants")
    .update({ busy_boost_minutes: d.minutes, busy_started_at: now.toISOString(), busy_until: until, busy_started_by: s.actor })
    .eq("id", s.restaurantId)
    .is("busy_until", null)
    .select("id");
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  if (!started?.length) return NextResponse.json({ error: "Busy is already on. End it first to change it.", code: "busy_already_on" }, { status: 409 });

  await recordCookTimeChange(admin, boostStartLog(s.restaurantId, prepMinutesOf(r.prep_minutes), d.minutes, until, who));
  return NextResponse.json({ busy: { minutes: d.minutes, started_at: now.toISOString(), until, started_by: s.actor }, changed: true });
}
