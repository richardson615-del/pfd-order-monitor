import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { storeSession } from "@/lib/store-session";
import { hoursMessageBody, parseHoursChange, readWeek } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/store/hours { hours: { sunday: [{open, close}], ... }, note? }
 *
 * The kitchen sends new weekly hours (migration 052). Nothing here changes
 * the hours: it is an `hours_change` message with the week in `details`;
 * the CRM applies it to the restaurant's hours (what ordering and open-now
 * read) and pushes the profile back, which clears "Sent to Premium".
 * Three a day per restaurant.
 */
export async function POST(req: NextRequest) {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const d = parseHoursChange(await req.json().catch(() => ({})));
  if (d.kind === "error") return NextResponse.json({ error: d.error }, { status: 400 });
  const admin = supabaseAdmin();
  const { count } = await admin
    .from("restaurant_messages")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", s.restaurantId)
    .eq("kind", "hours_change")
    .gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  if ((count ?? 0) >= 3) return NextResponse.json({ error: "That's three hours changes today. Call dispatch if something's still wrong." }, { status: 429 });
  const { data: profile } = await admin.from("restaurant_profiles").select("hours").eq("restaurant_id", s.restaurantId).maybeSingle();
  const { data: message, error } = await admin
    .from("restaurant_messages")
    .insert({ restaurant_id: s.restaurantId, direction: "from_restaurant", kind: "hours_change", body: hoursMessageBody(d.hours, readWeek(profile?.hours), d.note), details: { hours: d.hours, note: d.note } })
    .select("id, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sent_at: message.created_at }, { status: 201 });
}
