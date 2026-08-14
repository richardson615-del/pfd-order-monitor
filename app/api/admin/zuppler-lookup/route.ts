import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isCurrentUserAdmin } from "@/lib/authz";
import { resolveZupplerOrderUuid } from "@/lib/zuppler-email";
import { fetchZupplerOrder, mapZupplerGraphqlOrder } from "@/lib/zuppler-mapper";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/admin/zuppler-lookup
 * body: { input }   a receipt link, tracking link, order uuid, or pasted email
 *
 * Answers "what is this restaurant's Zuppler ID" without waiting for their
 * first live order. Zuppler's API exposes only order(id) - there is no
 * restaurant or channel lookup - but every receipt points at an order, and
 * every order carries its restaurantId.
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const input = typeof body?.input === "string" ? body.input : "";
  if (!input.trim()) {
    return NextResponse.json(
      { error: "Paste a receipt link, an order uuid, or the order email" },
      { status: 400 }
    );
  }

  const orderUuid = await resolveZupplerOrderUuid(input);
  if (!orderUuid) {
    return NextResponse.json(
      { error: "No Zuppler order found in that. Use the 'View your receipt' link from the order email." },
      { status: 422 }
    );
  }

  let mapped;
  try {
    mapped = mapZupplerGraphqlOrder(await fetchZupplerOrder(orderUuid));
  } catch (err: any) {
    return NextResponse.json(
      { error: `Zuppler could not load that order: ${err?.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  if (!mapped.zupplerRestaurantId) {
    return NextResponse.json(
      { error: "That order has no restaurant ID on it", order_uuid: orderUuid },
      { status: 422 }
    );
  }

  // Tell the operator if this ID is already spoken for - mapping it twice is
  // rejected by the unique constraint, and it usually means a wrong receipt.
  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("zuppler_restaurant_id", mapped.zupplerRestaurantId)
    .maybeSingle();

  return NextResponse.json({
    order_uuid: orderUuid,
    zuppler_restaurant_id: mapped.zupplerRestaurantId,
    order_number: mapped.canonical.orderNumber,
    customer_name: mapped.canonical.customerName,
    order_total: mapped.canonical.customerTotal,
    already_mapped_to: existing ? { id: existing.id, name: existing.name } : null,
  });
}
