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
 * body: { name, slug, monitored_email, sender_filter?, subject_pattern? }
 * Creates a restaurant and its (not-yet-connected) monitored inbox row.
 * The admin still needs to visit /api/gmail/connect?inbox_id=... to
 * authorize Gmail access for that inbox.
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { name, slug, monitored_email, sender_filter, subject_pattern } = body;

  if (!name || !slug || !monitored_email) {
    return NextResponse.json(
      { error: "name, slug, and monitored_email are required" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  const { data: restaurant, error: restaurantError } = await admin
    .from("restaurants")
    .insert({ name, slug })
    .select()
    .single();

  if (restaurantError) {
    return NextResponse.json({ error: restaurantError.message }, { status: 400 });
  }

  const { data: inbox, error: inboxError } = await admin
    .from("monitored_inboxes")
    .insert({
      restaurant_id: restaurant.id,
      email_address: monitored_email,
      sender_filter: sender_filter || "noreply@mail.datadreamers.us",
      subject_pattern: subject_pattern || "^Order\\s+(\\d+)",
      is_active: false, // becomes true once Gmail OAuth connect succeeds
    })
    .select()
    .single();

  if (inboxError) {
    return NextResponse.json({ error: inboxError.message }, { status: 400 });
  }

  return NextResponse.json({ restaurant, inbox });
}
