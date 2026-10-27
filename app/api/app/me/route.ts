import { NextResponse } from "next/server";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** GET /api/app/me -> { restaurant: { id, name } } for the signed-in app (PA1); 401 when the token is no good. */
export async function GET() {
  const {
    data: { user },
  } = await supabaseServer().auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "That login isn't linked to a restaurant." }, { status: 403 });
  const { data } = await supabaseAdmin().from("restaurants").select("id, name").eq("id", restaurantId).maybeSingle();
  return NextResponse.json({ restaurant: data }, { headers: { "Cache-Control": "no-store" } });
}
