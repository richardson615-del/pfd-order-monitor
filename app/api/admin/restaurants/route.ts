import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isCurrentUserAdmin } from "@/lib/authz";

/** GET /api/admin/restaurants - list all restaurants + their inboxes (admin only) */
export async function GET() {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("restaurants")
    .select("*, monitored_inboxes(*)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ restaurants: data });
}

/**
 * POST /api/admin/restaurants
 * body: { name, slug, monitored_email?, zuppler_restaurant_id?,
 *         sender_filter?, subject_pattern? }
 *
 * Creates a restaurant, and its (not-yet-connected) monitored inbox when an
 * email address is given. monitored_email is OPTIONAL: a venue that only takes
 * Zuppler orders has no inbox to watch, and requiring one meant those
 * restaurants had to be inserted by hand.
 *
 * The admin still needs to visit /api/gmail/connect?inbox_id=... to authorize
 * Gmail access for any inbox created here.
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    name, slug, monitored_email, zuppler_restaurant_id,
    sender_filter, subject_pattern,
  } = body;

  if (!name || !slug) {
    return NextResponse.json({ error: "name and slug are required" }, { status: 400 });
  }

  const zupplerId =
    typeof zuppler_restaurant_id === "string" && zuppler_restaurant_id.trim()
      ? zuppler_restaurant_id.trim()
      : null;

  // Zuppler ids are numeric; a typo here fails silently later (the order is
  // accepted and dropped as unmapped), so reject it now while someone is watching.
  if (zupplerId && !/^\d+$/.test(zupplerId)) {
    return NextResponse.json(
      { error: "Zuppler restaurant ID must be digits only, e.g. 29905" },
      { status: 400 }
    );
  }

  if (!monitored_email && !zupplerId) {
    return NextResponse.json(
      { error: "Give a monitored inbox, a Zuppler restaurant ID, or both - otherwise no orders can reach this restaurant" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  const { data: restaurant, error: restaurantError } = await admin
    .from("restaurants")
    .insert({ name, slug, zuppler_restaurant_id: zupplerId })
    .select()
    .single();

  if (restaurantError) {
    return NextResponse.json({ error: restaurantError.message }, { status: 400 });
  }

  if (!monitored_email) {
    // Zuppler-only venue: nothing to watch, so no inbox row.
    return NextResponse.json({ restaurant, inbox: null });
  }

  const { data: inbox, error: inboxError } = await admin
    .from("monitored_inboxes")
    .insert({
      restaurant_id: restaurant.id,
      email_address: monitored_email,
      sender_filter: sender_filter || "noreply@mail.datadreamers.us",
      // Covers both subject formats PFD sends: "Order 1195" and
      // "80eb0e25:Delivery order received for ...".
      subject_pattern: subject_pattern || "^(?:Order\\s+(\\d+)|([0-9a-f]{8})\\s*:)",
      is_active: false, // becomes true once Gmail OAuth connect succeeds
    })
    .select()
    .single();

  if (inboxError) {
    return NextResponse.json({ error: inboxError.message }, { status: 400 });
  }

  return NextResponse.json({ restaurant, inbox });
}

/**
 * PATCH /api/admin/restaurants
 * body: { id, zuppler_restaurant_id }
 *
 * Sets or clears the Zuppler restaurant id. Send "" to clear it - an honest
 * null is better than a wrong id, because both drop the order but only null
 * makes it obvious the mapping is missing.
 */
export async function PATCH(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const id = body?.id;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const raw = body?.zuppler_restaurant_id;
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (value && !/^\d+$/.test(value)) {
    return NextResponse.json(
      { error: "Zuppler restaurant ID must be digits only, e.g. 29905" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("restaurants")
    .update({ zuppler_restaurant_id: value })
    .eq("id", id)
    .select("id, name, slug, zuppler_restaurant_id")
    .maybeSingle();

  // The column is unique: the same id cannot be mapped to two restaurants.
  if (error) {
    const msg = /duplicate key|unique/i.test(error.message)
      ? `Zuppler ID ${value} is already mapped to another restaurant`
      : error.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  if (!data) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  return NextResponse.json({ restaurant: data });
}
