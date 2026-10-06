import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { THREAD_LIMIT, overRateLimit, parseTabletMessage, unreadCount, RATE_WINDOW_MS } from "@/lib/messages";

export const dynamic = "force-dynamic";

/**
 * The tablet's side of the dispatch thread (migration 048).
 *
 * GET  -> { messages[] (oldest first, last THREAD_LIMIT), unread }
 * POST { kind, body?, order_id? } -> { message }
 *
 * The restaurant is the session's, never the body's - the heartbeat's rule.
 * Reads go through the session client so RLS applies; the insert goes
 * through the service role because there is deliberately no insert policy,
 * and an order_id is only accepted when it belongs to this restaurant.
 */
async function sessionRestaurant() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return { error: NextResponse.json({ error: "no restaurant" }, { status: 400 }) };
  return { supabase, restaurantId };
}

export async function GET() {
  const s = await sessionRestaurant();
  if ("error" in s) return s.error;
  const { data, error } = await s.supabase
    .from("restaurant_messages")
    .select("id, restaurant_id, direction, kind, body, order_id, author, crm_ticket_no, created_at, read_at, menu_changes")
    .eq("restaurant_id", s.restaurantId)
    .order("created_at", { ascending: false })
    .limit(THREAD_LIMIT);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const messages = (data ?? []).reverse();
  return NextResponse.json({ messages, unread: unreadCount(messages) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const s = await sessionRestaurant();
  if ("error" in s) return s.error;
  const input = await req.json().catch(() => ({}));
  const parsed = parseTabletMessage(input ?? {});
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const admin = supabaseAdmin();
  const now = Date.now();

  const { data: recent, error: recentErr } = await admin
    .from("restaurant_messages")
    .select("created_at")
    .eq("restaurant_id", s.restaurantId)
    .eq("direction", "from_restaurant")
    .gte("created_at", new Date(now - RATE_WINDOW_MS).toISOString());
  if (recentErr) return NextResponse.json({ error: recentErr.message }, { status: 500 });
  if (overRateLimit((recent ?? []).map((r) => r.created_at as string), now)) {
    return NextResponse.json({ error: "Too many messages in a few minutes. Call dispatch if it's urgent." }, { status: 429 });
  }

  if (parsed.orderId) {
    const { data: order } = await admin.from("orders").select("id").eq("id", parsed.orderId).eq("restaurant_id", s.restaurantId).maybeSingle();
    if (!order) return NextResponse.json({ error: "that order isn't this restaurant's" }, { status: 400 });
  }

  const { data: message, error } = await admin
    .from("restaurant_messages")
    .insert({ restaurant_id: s.restaurantId, direction: "from_restaurant", kind: parsed.kind, body: parsed.body, order_id: parsed.orderId })
    .select("id, restaurant_id, direction, kind, body, order_id, author, crm_ticket_no, created_at, read_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ message }, { status: 201 });
}
