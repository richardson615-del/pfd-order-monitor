import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { storeSession } from "@/lib/store-session";
import { parseCookTime } from "@/lib/kitchen-alerts";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/store/cook-time { prep_minutes } -> { prep_minutes }
 *
 * KT1 (prs-crm Ticket #779): the kitchen sets its own default cook time -
 * restaurants.prep_minutes (migration 040), what Accept pre-selects and the
 * countdown runs from. One of the Accept quick picks (10/15/20/25/30/45).
 * The restaurant comes from the session; the CRM's own write stays
 * PATCH /api/crm/restaurants/:id { prep_minutes } (1-180). Orders already
 * accepted keep their ready_by.
 */
export async function POST(req: NextRequest) {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const d = parseCookTime(await req.json().catch(() => ({})));
  if (d.kind === "error") return NextResponse.json({ error: d.error }, { status: 400 });
  const { error } = await supabaseAdmin().from("restaurants").update({ prep_minutes: d.minutes }).eq("id", s.restaurantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ prep_minutes: d.minutes });
}
