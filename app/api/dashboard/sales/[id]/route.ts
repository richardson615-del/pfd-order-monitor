import { NextResponse } from "next/server";
import { SALES_COLUMNS, salesReceipt, type SalesOrder } from "@/lib/sales";
import { salesCaller } from "@/lib/sales-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/sales/:id (PA6)
 *
 * One order the way a receipt reads: every item with its price (and a
 * flag on any that came through with none), then items, discount, tax,
 * fees, tip and the total. Read through the session client, so RLS keeps
 * it to the restaurant's own orders; a test order is not shown.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const caller = await salesCaller();
  if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const { data, error } = await caller.supabase
    .from("orders")
    .select(SALES_COLUMNS)
    .eq("id", params.id)
    .eq("restaurant_id", caller.restaurantId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const order = data as unknown as SalesOrder | null;
  if (!order || order.source === "test") return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ receipt: salesReceipt(order, caller.timezone) }, { headers: { "Cache-Control": "no-store" } });
}
