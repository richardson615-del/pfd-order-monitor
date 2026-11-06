import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { storeSession } from "@/lib/store-session";
import { prepMinutesOf } from "@/lib/countdown";
import { COOK_LIMIT_SELECT, cookLimitsOf, defaultChangeLog, parseKitchenCookTime } from "@/lib/cook-time";
import { cookSourceOf, recordCookTimeChange } from "@/lib/cook-time-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/store/cook-time { prep_minutes } -> { prep_minutes }
 *
 * KT1 (prs-crm Ticket #779): the kitchen sets its own default cook time -
 * restaurants.prep_minutes (migration 040), what Accept pre-selects and the
 * countdown runs from. BT1 (Ticket #948): kept inside the restaurant's band
 * (10-45 unless the CRM set another), refused here with "Ask dispatch to change
 * it", and every change is a cook_time_log row. The restaurant comes from the
 * session; the CRM's own write stays POST /api/crm/restaurants/:id
 * { prep_minutes } (1-180). Orders already accepted keep their ready_by.
 */
export async function POST(req: NextRequest) {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const admin = supabaseAdmin();
  const { data: r, error: readError } = await admin.from("restaurants").select(`prep_minutes, ${COOK_LIMIT_SELECT}`).eq("id", s.restaurantId).single();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  const d = parseKitchenCookTime(await req.json().catch(() => ({})), cookLimitsOf(r));
  if (d.kind === "error") return NextResponse.json({ error: d.error, code: d.code }, { status: 400 });
  const { error } = await admin.from("restaurants").update({ prep_minutes: d.minutes }).eq("id", s.restaurantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const before = prepMinutesOf(r.prep_minutes);
  if (before !== d.minutes) {
    await recordCookTimeChange(admin, defaultChangeLog(s.restaurantId, before, d.minutes, { source: cookSourceOf(req.headers.get("authorization")), actor: s.actor }));
  }
  return NextResponse.json({ prep_minutes: d.minutes });
}
