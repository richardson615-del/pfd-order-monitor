import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** The last 30 hours: today's service plus late-night orders from yesterday. */
const PARTNER_ORDERS_WINDOW_MS = 30 * 60 * 60 * 1000;
const PARTNER_ORDERS_LIMIT = 200;

/** What the PFD Partner app's Orders tab shows, with the ready-timer fields (055). */
const ORDER_COLUMNS =
  "id, order_number, order_type, source, customer_name, customer_total, items, notes, due_time, status, received_at, accepted_at, ready_minutes, ready_by, ready_at, completed_at, cancelled_at";

/**
 * GET /api/dashboard/orders (PA3, 2026-10-27)
 *
 * The PFD Partner app's Orders tab: the restaurant's orders from the last
 * 30 hours, newest first, plus the kitchen's prep target and timezone so
 * the app can highlight the usual ready time. Read-only; writes stay on
 * PATCH /api/orders/:id. The restaurant comes from the session (cookie or
 * `Authorization: Bearer`, see supabaseServer), and the reads go through
 * the session client, so RLS applies exactly as it does for the tablet.
 */
export async function GET() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const since = new Date(Date.now() - PARTNER_ORDERS_WINDOW_MS).toISOString();
  const [{ data: restaurant }, { data: orders, error }] = await Promise.all([
    supabase.from("restaurants").select("prep_minutes, timezone").eq("id", restaurantId).maybeSingle(),
    supabase
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("restaurant_id", restaurantId)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(PARTNER_ORDERS_LIMIT),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(
    {
      orders: orders ?? [],
      kitchen: { prep_minutes: restaurant?.prep_minutes ?? null, timezone: restaurant?.timezone ?? null },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
