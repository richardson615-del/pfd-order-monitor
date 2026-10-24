import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";

/** The signed-in restaurant for a Store route (the session decides; never a request body). */
export async function storeSession(): Promise<{ restaurantId: string } | { error: NextResponse }> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return { error: NextResponse.json({ error: "no restaurant" }, { status: 400 }) };
  return { restaurantId };
}

export const DEFAULT_ZONE = "America/Chicago";
