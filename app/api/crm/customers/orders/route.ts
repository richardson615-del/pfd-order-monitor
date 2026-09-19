import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/crm/customers/orders?from=&to=[&limit=][&offset=]
 *
 * A per-order feed of customer-identifying fields, for a date range --
 * purpose-built for prs-crm's Marketing & Pricing pillar (Phase 1, a
 * customers/customer_orders table), 2026-09-19. Deliberately NOT added to
 * `/api/crm/accounting/orders`: that endpoint is fetched broadly by money
 * reconciliation and payout code that has no legitimate need to see
 * customer name/phone/email, and bolting customer PII onto a
 * general-purpose money endpoint would widen its exposure for every
 * caller, not just the one that needs it. This route exists so customer
 * identity data has its own, narrower surface.
 *
 * Also distinct from `/api/crm/orders`: that one is shaped for the live
 * tablet/dashboard (one LOCAL DAY at a time, `ORDERS_LIST_LIMIT` capped,
 * redacts phone on its list view). This route is a bulk, paginated,
 * date-RANGE export -- a backfill over months of history needs to ask for
 * a range, not loop one day at a time against an endpoint built for
 * "what's on the tablet right now."
 *
 * Same pagination contract as accounting/orders (2026-09-19 fix): `limit`
 * (default 1000, max 2000) caps a response; `truncated: true` means
 * request `offset + limit` next. Internally chunked so the platform's own
 * per-request row cap can never silently under-return a page while
 * reporting `truncated: false` -- see that route's own header comment for
 * the incident this pattern exists to prevent.
 *
 * Excludes: `source = 'test'` (not revenue), cancelled orders (a
 * cancelled order never became a real customer interaction worth
 * counting in frequency/lifetime-spend). Includes both `zuppler` and
 * `email` sources -- the email-leg (AEM) parser captures name/phone (no
 * email extraction there yet), still real identity signal.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const q = req.nextUrl.searchParams;
  const from = q.get("from");
  const to = q.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required (ISO dates, e.g. 2026-09-01)" }, { status: 400 });
  }
  const fromISO = new Date(from).toISOString();
  const toDate = new Date(to);
  toDate.setUTCHours(23, 59, 59, 999);
  const toISO = toDate.toISOString();
  if (isNaN(Date.parse(fromISO)) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: "from/to must be parseable dates" }, { status: 400 });
  }

  const limit = Math.min(2000, Math.max(1, Number(q.get("limit") || 1000)));
  const offset = Math.max(0, Number(q.get("offset") || 0));
  const SUPABASE_SAFE_CHUNK = 500; // see accounting/orders' own "SAME-DAY CORRECTION" comment for why this exists

  const admin = supabaseAdmin();
  const SELECT_COLUMNS =
    "id, source, order_type, received_at, items_total, payment_type, customer_name, customer_phone, customer_email, restaurant_id, restaurants(zuppler_restaurant_id)";

  const data: any[] = [];
  let chunkOffset = offset;
  const targetCount = limit + 1;
  while (data.length < targetCount) {
    const chunkLimit = Math.min(SUPABASE_SAFE_CHUNK, targetCount - data.length);
    const { data: chunk, error } = await admin
      .from("orders")
      .select(SELECT_COLUMNS)
      .gte("received_at", fromISO)
      .lte("received_at", toISO)
      .neq("source", "test")
      .is("cancelled_at", null)
      .order("received_at", { ascending: true })
      .order("id", { ascending: true })
      .range(chunkOffset, chunkOffset + chunkLimit - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    data.push(...(chunk ?? []));
    if (!chunk || chunk.length < chunkLimit) break;
    chunkOffset += chunk.length;
  }

  const truncated = data.length > limit;
  if (truncated) data.length = limit;

  const num = (v: unknown) => (v == null ? null : Number(v));
  const orders = data.map((o: any) => ({
    order_id: o.id,
    source: o.source,
    order_type: o.order_type,
    received_at: o.received_at,
    subtotal: num(o.items_total),
    tender: o.payment_type,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    customer_email: o.customer_email,
    restaurant: {
      id: o.restaurant_id,
      zuppler_restaurant_id: o.restaurants?.zuppler_restaurant_id ?? null,
    },
  }));

  return NextResponse.json({
    from: fromISO,
    to: toISO,
    count: orders.length,
    truncated,
    offset,
    limit,
    orders,
  });
}
