import { supabaseServer } from "./supabase-server";

/** True if the currently logged-in user is a PFD admin (row in `admins`). */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from("admins")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  return !!data;
}

/** Returns the restaurant_id(s) the current user belongs to. */
export async function getCurrentUserRestaurantIds(): Promise<string[]> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("restaurant_users")
    .select("restaurant_id")
    .eq("auth_user_id", user.id);

  return (data || []).map((r) => r.restaurant_id);
}
