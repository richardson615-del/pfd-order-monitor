/**
 * The sales routes' shared read (PA6). Server only.
 *
 * Reads through the caller's session client, so RLS applies: a restaurant
 * (tablet cookie, or the PFD Partner app's Bearer token) sees only its own
 * orders. Paged in chunks of 1000, because a single .range() read is
 * silently capped at 1000 rows by the platform (see
 * app/api/crm/accounting/orders/route.ts, 2026-09-19).
 */
import { supabaseServer } from "./supabase-server";
import { getCurrentUserRestaurantIds } from "./authz";
import { SALES_COLUMNS, SALES_ORDER_CAP, salesQueryWindow, type SalesOrder, type SalesRange } from "./sales";

const PAGE = 1000;

export type SalesCaller =
  | { ok: true; supabase: ReturnType<typeof supabaseServer>; restaurantId: string; timezone: string | null; name: string | null }
  | { ok: false; status: number; error: string };

/** The signed-in restaurant, its zone and name, or why not. */
export async function salesCaller(): Promise<SalesCaller> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return { ok: false, status: 400, error: "no restaurant" };
  const { data: restaurant } = await supabase.from("restaurants").select("name, timezone").eq("id", restaurantId).maybeSingle();
  return { ok: true, supabase, restaurantId, timezone: restaurant?.timezone ?? null, name: restaurant?.name ?? null };
}

/** Every order in the range's query window, up to SALES_ORDER_CAP. */
export async function fetchSalesOrders(
  caller: Exclude<SalesCaller, { error: string }>,
  range: SalesRange
): Promise<{ orders: SalesOrder[]; truncated: boolean } | { error: string }> {
  const { since, until } = salesQueryWindow(range);
  const orders: SalesOrder[] = [];
  for (let offset = 0; offset < SALES_ORDER_CAP; offset += PAGE) {
    const { data, error } = await caller.supabase
      .from("orders")
      .select(SALES_COLUMNS)
      .eq("restaurant_id", caller.restaurantId)
      .gte("received_at", since)
      .lt("received_at", until)
      .order("received_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { error: error.message };
    const page = (data ?? []) as unknown as SalesOrder[];
    orders.push(...page);
    if (page.length < PAGE) return { orders, truncated: false };
  }
  return { orders, truncated: true };
}
