import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { parseMenuPush } from "@/lib/menu-editor";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PUT /api/crm/restaurants/:id/menu
 *   { menu_id, source, categories: [{ ref, name, items: [{ ref, name, price_cents, available, description }] }] }
 *
 * The CRM pushes a restaurant's current menu for the tablet's Menu tab
 * (migration 049). One row per restaurant, replaced whole on every push -
 * the CRM is the source and this is a copy. The CRM pushes after every
 * menu refresh and every publish, so an edit the kitchen sent shows up as
 * the real menu once it is live and the "Sent to Premium" mark clears.
 *
 * GET returns what is held, for the CRM to check a push landed.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const parsed = parseMenuPush(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error, code: "invalid" }, { status: 400 });

  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null }>(params.id, "id, crm_restaurant_id");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });

  const pushedAt = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from("restaurant_menus")
    .upsert(
      {
        restaurant_id: restaurant.id,
        crm_menu_id: parsed.menu.menu_id,
        source: parsed.menu.source,
        menu: { categories: parsed.menu.categories },
        item_count: parsed.itemCount,
        pushed_at: pushedAt,
      },
      { onConflict: "restaurant_id" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    restaurant_id: restaurant.id,
    crm_restaurant_id: restaurant.crm_restaurant_id,
    menu_id: parsed.menu.menu_id,
    item_count: parsed.itemCount,
    pushed_at: pushedAt,
  });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null }>(params.id, "id, crm_restaurant_id");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });

  const { data, error } = await supabaseAdmin()
    .from("restaurant_menus")
    .select("crm_menu_id, source, item_count, pushed_at")
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { restaurant_id: restaurant.id, crm_restaurant_id: restaurant.crm_restaurant_id, menu: data ? { menu_id: data.crm_menu_id, source: data.source, item_count: data.item_count, pushed_at: data.pushed_at } : null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
