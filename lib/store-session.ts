import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { actorOf } from "@/lib/cook-time-data";

/** The signed-in restaurant for a Store route (the session decides; never a request body). */
export async function storeSession(): Promise<{ restaurantId: string; actor: string | null } | { error: NextResponse }> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return { error: NextResponse.json({ error: "no restaurant" }, { status: 400 }) };
  return { restaurantId, actor: actorOf(user) };
}

export const DEFAULT_ZONE = "America/Chicago";
