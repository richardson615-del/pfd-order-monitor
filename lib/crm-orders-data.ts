import { supabaseAdmin } from "./supabase-server";
import type { PrintJobRow, RestaurantRef } from "./crm-orders";

/** The columns a list row is built from. The full phone is read and reduced to its last four; raw_html is never read. */
export const ORDER_LIST_SELECT =
  "id, order_number, source, status, restaurant_id, received_at, opened_at, accepted_at, completed_at, cancelled_at, printed_at, updated_at, due_time, order_type, payment_type, channel_id, customer_name, customer_phone, items, customer_total";

/**
 * The detail adds the address, the notes, the money and the source ids.
 * raw_html and raw_payload are deliberately NOT here: the email parser's
 * source can carry card-holder data, and nobody in the office needs it.
 */
export const ORDER_DETAIL_SELECT =
  ORDER_LIST_SELECT +
  ", customer_address, notes, external_id, items_total, tax, service_fee, delivery_fee, tip, discount, included_tax, hidden_fee, money_variance, ticket_restaurant_name";

/**
 * The restaurants and print jobs behind a set of orders - two reads,
 * however many rows. Shared with the detail route.
 */
export async function loadOrderContext(orders: { id: string; restaurant_id: string }[]): Promise<{
  restaurants: Map<string, RestaurantRef>;
  jobsByOrder: Map<string, PrintJobRow[]>;
}> {
  const admin = supabaseAdmin();
  const restaurantIds = [...new Set(orders.map((o) => o.restaurant_id))];
  const orderIds = orders.map((o) => o.id);
  const [{ data: rRows }, { data: dRows }, { data: jRows }] = await Promise.all([
    restaurantIds.length
      ? admin.from("restaurants").select("id, crm_restaurant_id, name, prep_minutes, print_method, app_expected").in("id", restaurantIds)
      : Promise.resolve({ data: [] as any[] }),
    restaurantIds.length
      ? admin.from("print_devices").select("restaurant_id").eq("is_active", true).in("restaurant_id", restaurantIds)
      : Promise.resolve({ data: [] as any[] }),
    orderIds.length
      ? admin
          .from("print_jobs")
          .select("id, order_id, status, delivery, device_id, queued_at, claimed_at, finished_at, sent_at, attempts, error, send_error, queued_by, delivered_count, print_devices(name)")
          .in("order_id", orderIds)
          .order("queued_at", { ascending: true })
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const withPrinter = new Set((dRows ?? []).map((d: any) => d.restaurant_id));
  const restaurants = new Map<string, RestaurantRef>();
  for (const r of (rRows ?? []) as any[]) restaurants.set(r.id, { ...r, has_active_printer: withPrinter.has(r.id) });
  const jobsByOrder = new Map<string, PrintJobRow[]>();
  for (const j of (jRows ?? []) as any[]) {
    const list = jobsByOrder.get(j.order_id) ?? [];
    list.push({ ...j, device_name: j.print_devices?.name ?? null });
    jobsByOrder.set(j.order_id, list);
  }
  return { restaurants, jobsByOrder };
}
