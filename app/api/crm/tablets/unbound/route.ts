import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { UNBOUND_VISIBLE_MS, deviceRefKind } from "@/lib/device-binding";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/tablets/unbound
 *
 * Tablets that have bootstrapped and are not assigned to any restaurant:
 * the "New tablet seen 2 min ago · <model> · Assign to…" rows on the
 * CRM's Tablets page (1b-ii). Seen within the last week; a reference that
 * stopped calling in is not a tablet somebody is holding.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const { data, error } = await supabaseAdmin()
    .from("kiosk_devices")
    .select("device_ref, model, user_agent, first_seen_at, last_seen_at")
    .is("restaurant_id", null)
    .gte("last_seen_at", new Date(Date.now() - UNBOUND_VISIBLE_MS).toISOString())
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = { device_ref: string; model: string | null; user_agent: string | null; first_seen_at: string; last_seen_at: string | null };
  return NextResponse.json({
    devices: ((data ?? []) as Row[]).map((d) => ({
      device_ref: d.device_ref,
      kind: deviceRefKind(d.device_ref),
      model: d.model,
      user_agent: d.user_agent,
      first_seen_at: d.first_seen_at,
      last_seen_at: d.last_seen_at,
    })),
  });
}
