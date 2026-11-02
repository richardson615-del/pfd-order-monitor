import { NextRequest, NextResponse } from "next/server";
import { isCurrentUserAdmin } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/supabase-server";
import { pairPrinter } from "@/lib/printer-pairing";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/print-devices/pair   { code, restaurant_id, name? }
 *
 * The admin panel's half of pairing: the printer shows a six-digit code,
 * the office types it here against a restaurant. Answers with the new
 * device, never its key - the printer collects that itself.
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const restaurantId = typeof body?.restaurant_id === "string" ? body.restaurant_id : "";
  if (!restaurantId) return NextResponse.json({ error: "Pick the restaurant." }, { status: 400 });

  const { data: restaurant } = await supabaseAdmin().from("restaurants").select("id, name").eq("id", restaurantId).maybeSingle();
  if (!restaurant) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  const res = await pairPrinter(body?.code, restaurant, typeof body?.name === "string" ? body.name : null, "admin panel");
  if ("error" in res) return NextResponse.json({ code: res.code, error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true, device: res.device, restaurant: res.restaurant });
}
