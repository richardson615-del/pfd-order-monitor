import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { RATE_WINDOW_MS, overRateLimit } from "@/lib/messages";
import { parseMenuEdits, type TabletMenu } from "@/lib/menu-editor";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/menu/changes  { edits: [{ ref, action, price_cents?, name? }] } -> { message }
 *
 * A change made on the Menu tab (migration 049). Validated against the menu
 * this restaurant's tablet is showing - a ref the CRM has since replaced is
 * refused (409) and the tab reloads. Stored as a menu_change message with
 * `menu_changes` filled, so dispatch sees it in the same thread as every
 * other message and the CRM gets exact parser lines. The same send limit as
 * typed messages.
 */
export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const input = (await req.json().catch(() => ({}))) ?? {};
  const admin = supabaseAdmin();

  const { data: row, error: menuErr } = await admin.from("restaurant_menus").select("crm_menu_id, source, menu").eq("restaurant_id", restaurantId).maybeSingle();
  if (menuErr) return NextResponse.json({ error: menuErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "no menu on this tablet yet", code: "no_menu" }, { status: 409 });
  const menu: TabletMenu = { menu_id: row.crm_menu_id, source: row.source, categories: (row.menu as { categories: TabletMenu["categories"] }).categories ?? [] };

  if (typeof input.menu_id === "string" && input.menu_id !== menu.menu_id) {
    return NextResponse.json({ error: "the menu changed since this screen loaded", code: "stale_menu" }, { status: 409 });
  }
  const parsed = parseMenuEdits(input.edits, menu);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error, code: "invalid" }, { status: 400 });

  const now = Date.now();
  const { data: recent, error: recentErr } = await admin
    .from("restaurant_messages")
    .select("created_at")
    .eq("restaurant_id", restaurantId)
    .eq("direction", "from_restaurant")
    .gte("created_at", new Date(now - RATE_WINDOW_MS).toISOString());
  if (recentErr) return NextResponse.json({ error: recentErr.message }, { status: 500 });
  if (overRateLimit((recent ?? []).map((r) => r.created_at as string), now)) {
    return NextResponse.json({ error: "Too many changes in a few minutes. Call Premium if it's urgent." }, { status: 429 });
  }

  const { data: message, error } = await admin
    .from("restaurant_messages")
    .insert({ restaurant_id: restaurantId, direction: "from_restaurant", kind: "menu_change", body: parsed.body, menu_changes: parsed.menuChanges })
    .select("id, restaurant_id, direction, kind, body, order_id, author, crm_ticket_no, created_at, read_at, menu_changes")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ message }, { status: 201 });
}
