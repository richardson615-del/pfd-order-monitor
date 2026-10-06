import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { parseCrmReply } from "@/lib/messages";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** At most this many kitchen messages per read; `truncated` says there are more. */
const FEED_LIMIT = 500;

/**
 * GET /api/crm/messages[?since=<iso>]
 *
 * What restaurants wrote to dispatch from their tablets (migration 048),
 * oldest first, for the CRM's cron to turn into tickets. `since` is
 * inclusive (created_at >= since) so a message written in the same
 * millisecond as the last one read is never skipped; the CRM dedupes on
 * the message `id`. Without `since`, the last 24 hours.
 *
 * Each message carries both restaurant ids (the two-id rule) and, when it is
 * about an order, enough of the order to put on a ticket - never the
 * customer's phone or address.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const now = new Date();
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;
  const windowStart = since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const admin = supabaseAdmin();
  const { data: rows, error } = await admin
    .from("restaurant_messages")
    .select("id, restaurant_id, kind, body, order_id, created_at, menu_changes")
    .eq("direction", "from_restaurant")
    .gte("created_at", windowStart.toISOString())
    .order("created_at", { ascending: true })
    .limit(FEED_LIMIT + 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const list = (rows ?? []).slice(0, FEED_LIMIT);
  const restaurantIds = [...new Set(list.map((r) => r.restaurant_id as string))];
  const orderIds = [...new Set(list.map((r) => r.order_id as string | null).filter((x): x is string => !!x))];

  const [{ data: restaurants }, { data: orders }] = await Promise.all([
    restaurantIds.length
      ? admin.from("restaurants").select("id, crm_restaurant_id, name").in("id", restaurantIds)
      : Promise.resolve({ data: [] as { id: string; crm_restaurant_id: string | null; name: string }[] }),
    orderIds.length
      ? admin.from("orders").select("id, order_number, order_type, customer_name, status, received_at, accepted_at").in("id", orderIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const byRestaurant = new Map<string, { id: string; crm_restaurant_id: string | null; name: string }>(
    ((restaurants ?? []) as { id: string; crm_restaurant_id: string | null; name: string }[]).map((r) => [r.id, r] as const)
  );
  const byOrder = new Map<string, Record<string, unknown>>(((orders ?? []) as Record<string, unknown>[]).map((o) => [o.id as string, o] as const));

  const messages = list.map((m) => {
    const r = byRestaurant.get(m.restaurant_id as string);
    return {
      id: m.id,
      restaurant_id: m.restaurant_id,
      crm_restaurant_id: r?.crm_restaurant_id ?? null,
      restaurant_name: r?.name ?? null,
      kind: m.kind,
      body: m.body,
      // Set when the change was made on the Menu tab (049): { menu_id, lines[] in the
      // CRM parser's grammar by ref, changes[] }. Null for a typed menu_change.
      menu_changes: m.menu_changes ?? null,
      created_at: m.created_at,
      order: m.order_id ? byOrder.get(m.order_id as string) ?? null : null,
    };
  });

  return NextResponse.json(
    { checked_at: now.toISOString(), since: since?.toISOString() ?? null, truncated: (rows ?? []).length > FEED_LIMIT, messages },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * POST /api/crm/messages  { restaurant, body, author?, ticket_no? }
 *
 * A dispatcher's reply, shown on that restaurant's tablet with a chime.
 * `restaurant` is either id (bridge uuid or CRM account id). `author` is the
 * name the kitchen sees ("Kayla"); the CRM sends the dispatcher's first name.
 * 404 when the restaurant is not known here.
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const parsed = parseCrmReply((await req.json().catch(() => ({}))) ?? {});
  if ("error" in parsed) return NextResponse.json({ error: parsed.error, code: "invalid" }, { status: 400 });

  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null }>(parsed.restaurantRef, "id, crm_restaurant_id");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });

  const { data: message, error } = await supabaseAdmin()
    .from("restaurant_messages")
    .insert({
      restaurant_id: restaurant.id,
      direction: "to_restaurant",
      kind: "text",
      body: parsed.body,
      author: parsed.author,
      crm_ticket_no: parsed.ticketNo,
    })
    .select("id, restaurant_id, direction, kind, body, author, crm_ticket_no, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ message: { ...message, crm_restaurant_id: restaurant.crm_restaurant_id } }, { status: 201 });
}
