import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { supabaseAdmin } from "@/lib/supabase-server";
import { prepMinutesOf } from "@/lib/countdown";
import { BUSY_SELECT, COOK_LIMIT_SELECT, DEFAULT_COOK_LIMITS, acceptMinutes, cookLimitsOf, liveBusy, parseCookLimits } from "@/lib/cook-time";
import { endBusy, logLimitOf, readRestaurantCookLog } from "@/lib/cook-time-data";

export const dynamic = "force-dynamic";

const SELECT = `id, name, crm_restaurant_id, prep_minutes, ${BUSY_SELECT}, ${COOK_LIMIT_SELECT}`;

const stateOf = (r: any) => {
  const busy = liveBusy(r, Date.now());
  const prep = prepMinutesOf(r.prep_minutes);
  return { prep_minutes: prep, accept_minutes: acceptMinutes(prep, busy), busy, limits: cookLimitsOf(r), default_limits: DEFAULT_COOK_LIMITS };
};

const cleanActor = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

/**
 * GET /api/crm/restaurants/:id/cook-time[?limit=20] (either id)
 * -> { prep_minutes, accept_minutes, busy, limits, default_limits, log }
 *
 * The partner page's view (BT1, migration 058): the boost in force, the limits,
 * and the last changes, newest first.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const r = await findRestaurantByRef<any>(params.id, SELECT);
  if (!r) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
  try {
    const log = await readRestaurantCookLog(supabaseAdmin(), r.id, logLimitOf(req.nextUrl.searchParams.get("limit"), 20));
    return NextResponse.json({ ...stateOf(r), log });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "could not read the cook-time log" }, { status: 500 });
  }
}

/**
 * POST /api/crm/restaurants/:id/cook-time (either id)
 *   { action: "end_busy", actor? }              -> { ok, changed, ...state }
 *   { action: "set_limits", limits, actor? }    -> { ok, changed, ...state }
 *
 * Only the CRM writes limits. A limit set to null goes back to the default. A
 * boost already running is not cut short by a lower limit; End busy does that.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const body = await req.json().catch(() => null);
  const r = await findRestaurantByRef<any>(params.id, SELECT);
  if (!r) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
  const admin = supabaseAdmin();

  if (body?.action === "end_busy") {
    const ended = await endBusy(admin, r, { source: "crm", actor: cleanActor(body.actor) });
    if (ended.error) return NextResponse.json({ error: ended.error }, { status: 500 });
    return NextResponse.json({ ok: true, changed: ended.changed, ...stateOf(ended.changed ? { ...r, busy_boost_minutes: null, busy_until: null } : r) });
  }

  if (body?.action === "set_limits") {
    const d = parseCookLimits(body.limits, r);
    if (d.kind === "error") return NextResponse.json({ error: d.error, code: d.code }, { status: 400 });
    const { error } = await admin.from("restaurants").update(d.columns).eq("id", r.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, changed: true, ...stateOf({ ...r, ...d.columns }) });
  }

  return NextResponse.json({ error: 'action must be "end_busy" or "set_limits"', code: "invalid_action" }, { status: 400 });
}
