import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { isoWithOffset, pendingRefs, restOfTodayUntil, untilLabel, type MenuChanges, type TabletMenu } from "@/lib/menu-editor";
import { DEFAULT_ZONE } from "@/lib/store-session";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/menu -> { menu | null, pushed_at, pending: ref[], rest_of_today_until }
 *
 * The Menu tab's read (migration 049): the menu as the CRM last pushed it,
 * through the session client so RLS applies, plus the refs with a change
 * sent since that push ("Sent to Premium"). `menu` is null when the CRM has
 * not pushed one yet; the tab says so and points at Message dispatch.
 * `rest_of_today_until` is the words for the sold-out prompt ("11:00 AM
 * tomorrow"), null when the hours could not be read. The sold-out change works
 * its own time out when it is sent.
 */
export async function GET() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const { data: row, error } = await supabase
    .from("restaurant_menus")
    .select("crm_menu_id, source, menu, pushed_at")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ menu: null, pushed_at: null, pending: [] }, { headers: { "Cache-Control": "no-store" } });

  const { data: sent } = await supabase
    .from("restaurant_messages")
    .select("created_at, menu_changes")
    .eq("restaurant_id", restaurantId)
    .eq("kind", "menu_change")
    .eq("direction", "from_restaurant")
    .gt("created_at", row.pushed_at)
    .limit(200);

  const [restaurant, profile] = await Promise.all([
    supabase.from("restaurants").select("timezone").eq("id", restaurantId).maybeSingle(),
    supabase.from("restaurant_profiles").select("hours").eq("restaurant_id", restaurantId).maybeSingle(),
  ]);
  const now = new Date();
  const zone = restaurant.data?.timezone ?? DEFAULT_ZONE;
  const restOfToday = restaurant.error || profile.error ? null : untilLabel(isoWithOffset(restOfTodayUntil(profile.data?.hours, now, zone), zone), now, zone);

  const menu: TabletMenu = { menu_id: row.crm_menu_id, source: row.source, categories: (row.menu as { categories: TabletMenu["categories"] }).categories ?? [] };
  const pending = pendingRefs((sent ?? []) as { created_at: string; menu_changes: MenuChanges | null }[], row.pushed_at);
  return NextResponse.json({ menu, pushed_at: row.pushed_at, pending: [...pending], rest_of_today_until: restOfToday }, { headers: { "Cache-Control": "no-store" } });
}
