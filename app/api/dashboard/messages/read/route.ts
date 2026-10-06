import { NextResponse } from "next/server";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/messages/read - the kitchen opened the thread, so every
 * dispatch reply on it has been seen. Only this restaurant's, only replies,
 * only ones not already marked.
 */
export async function POST() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const { error } = await supabaseAdmin()
    .from("restaurant_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("restaurant_id", restaurantId)
    .eq("direction", "to_restaurant")
    .is("read_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
