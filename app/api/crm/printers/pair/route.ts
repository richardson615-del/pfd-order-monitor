import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { pairPrinter } from "@/lib/printer-pairing";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/printers/pair   { code, restaurant_id, name?, actor? }
 *
 * The CRM's half of printer pairing, the same shape as /api/crm/tablets/link:
 * a printer shows a six-digit code, somebody types it in the CRM against the
 * restaurant, and the printer picks up its key on its next poll. Refusals
 * carry `code` + `error` for the CRM's asRefusal.
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const restaurantId = typeof body?.restaurant_id === "string" ? body.restaurant_id : null;
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;
  if (!restaurantId) return NextResponse.json({ error: "restaurant_id required" }, { status: 400 });

  const restaurant = await findRestaurantByRef<{ id: string; name: string }>(restaurantId, "id, name");
  if (!restaurant) return NextResponse.json({ code: "restaurant_not_found", error: "restaurant not found" }, { status: 404 });

  const res = await pairPrinter(body?.code, restaurant, typeof body?.name === "string" ? body.name : null, actor);
  if ("error" in res) return NextResponse.json({ code: res.code, error: res.error }, { status: res.status });
  return NextResponse.json({
    ok: true,
    restaurant: res.restaurant,
    device: res.device,
    note: `Paired. The printer picks it up within a few seconds, prints a PRINTER ONLINE slip and starts printing ${res.restaurant.name}'s orders.`,
  });
}
