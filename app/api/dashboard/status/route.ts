import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { DEFAULT_THRESHOLDS } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/status
 *
 * What the tablet's Ready screen needs to say about the restaurant's own
 * equipment, from the tablet's own session: is there a kitchen printer,
 * and has it checked in lately. Read once on first run and on each
 * "Check again"; never assumed.
 *
 * `printer` is null when the restaurant has no active printer at all -
 * the Ready screen omits the row rather than ticking it - and `online`
 * uses the same silence threshold the health checks alarm on, so this
 * screen and the office cannot disagree about whether a printer is up.
 */
export async function GET() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const admin = supabaseAdmin();
  const [{ data: restaurant }, { data: devices }] = await Promise.all([
    admin.from("restaurants").select("id, name, print_method").eq("id", restaurantId).maybeSingle(),
    admin
      .from("print_devices")
      .select("id, name, last_seen_at")
      .eq("restaurant_id", restaurantId)
      .eq("is_active", true),
  ]);

  const now = Date.now();
  const silentMs = DEFAULT_THRESHOLDS.deviceSilentMinutes * 60_000;
  const printers = (devices ?? []).map((d: { id: string; name: string; last_seen_at: string | null }) => {
    const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : NaN;
    return { id: d.id, name: d.name, last_seen_at: d.last_seen_at, online: !Number.isNaN(seen) && now - seen < silentMs };
  });

  return NextResponse.json(
    {
      restaurant: restaurant ? { id: restaurant.id, name: restaurant.name } : null,
      printer:
        restaurant?.print_method !== "email" && printers.length
          ? { online: printers.some((p) => p.online), printers }
          : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
