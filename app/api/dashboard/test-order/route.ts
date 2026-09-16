import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { sendTestOrder } from "@/lib/test-order";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/test-order
 *
 * "Send me a test order" - the button on the tablet's own Ready screen.
 *
 * Authenticated by the tablet's session, and the restaurant is taken from
 * that session rather than from the body, the same way the heartbeat does
 * it: a tablet may only send a test order to itself. What the order is,
 * and where it goes, is lib/test-order.ts - the same function the office
 * presses from the CRM.
 */
export async function POST() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const result = await sendTestOrder(restaurantId);
  return NextResponse.json(result.body, { status: result.status });
}
