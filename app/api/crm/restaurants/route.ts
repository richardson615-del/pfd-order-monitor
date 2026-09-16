import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_FOOTER_TEXT } from "@/lib/ticket";
import { resolveOrCreateRestaurant } from "@/lib/restaurant-resolve";
import { planZupplerMapping, type ExistingMapping, type RequestedListing } from "@/lib/zuppler-mapping";
import { RESTAURANT_SELECT, loadRosterContext, shapeRestaurantRow, zupplerIdsFor } from "@/lib/crm-roster";
import { minShellVersion } from "@/lib/app-update";
import { isValidTimeZone } from "@/lib/clock";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/restaurants - the roster, with what each one prints on its
 * ticket footer. Restaurant-level rather than device-level: the footer belongs
 * to the business, not to a particular printer, and moving a printer must not
 * move the message.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const { data, error } = await admin.from("restaurants").select(RESTAURANT_SELECT).order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Side tables read once for the whole roster; each row is then shaped by
  // the same function GET /:id and the issues feed use (lib/crm-roster.ts).
  const ctx = await loadRosterContext();

  return NextResponse.json({
    // So the console can show what will actually print, rather than an empty
    // box that silently becomes the PFD line at print time.
    default_footer_text: DEFAULT_FOOTER_TEXT,
    // The oldest Android shell the office is happy with (MIN_SHELL_VERSION),
    // so the console can flag a tablet's shell_version without hardcoding
    // a number. null = no opinion set.
    latest_shell_version: minShellVersion() || null,
    restaurants: (data ?? []).map((r: any) => shapeRestaurantRow(r, ctx)),
  });
}

/**
 * POST /api/crm/restaurants - link an account's Zuppler listings to its
 * restaurant here, creating the restaurant if this is the first the bridge
 * has heard of it.
 *
 * body: { crm_restaurant_id, restaurant_name,
 *         zuppler_ids: [{ zuppler_restaurant_id, label? }, ...] }
 *
 * Exists because the CRM is the system that knows which listings belong to
 * whom (zuppler_locations, attached to accounts by a person), and until now
 * the only way to tell this database was a SQL editor. Larry's pickup listing
 * refused a live order on 2026-09-15 while the CRM had known it was Larry's
 * for weeks.
 *
 * Idempotent: send the same list twice and nothing changes. Additive: ids not
 * in the list are left alone - a sync must never quietly unmap a listing.
 * The first id is the primary (restaurants.zuppler_restaurant_id, which
 * accounting joins on) and only fills that column when it is empty.
 * Refuses the whole request on any id already owned by another restaurant.
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const requested: RequestedListing[] = Array.isArray(body.zuppler_ids) ? [...body.zuppler_ids] : [];
  // E1 shape: a single zuppler_restaurant_id is the primary listing. Folded
  // into the same list so both callers get the same rules.
  if (typeof body.zuppler_restaurant_id === "string" && body.zuppler_restaurant_id.trim()) {
    requested.unshift({ zuppler_restaurant_id: body.zuppler_restaurant_id.trim(), label: "primary" });
  }

  // Settings the CRM may set on create-or-ensure (E1). Each validated the
  // same way the per-restaurant update route validates it; absent = untouched.
  const settings: Record<string, unknown> = {};
  if ("timezone" in body) {
    if (body.timezone === null || body.timezone === "") settings.timezone = null;
    else if (isValidTimeZone(body.timezone)) settings.timezone = String(body.timezone).trim();
    else return NextResponse.json({ error: "timezone must be an IANA zone name such as America/Chicago, or null", code: "invalid_timezone" }, { status: 400 });
  }
  if ("app_expected" in body) {
    if (typeof body.app_expected !== "boolean") return NextResponse.json({ error: "app_expected must be true or false" }, { status: 400 });
    settings.app_expected = body.app_expected;
  }
  if ("display_mode" in body) {
    if (body.display_mode !== "kitchen" && body.display_mode !== "standard") {
      return NextResponse.json({ error: "display_mode must be 'kitchen' or 'standard'" }, { status: 400 });
    }
    settings.display_mode = body.display_mode;
  }

  const resolved = await resolveOrCreateRestaurant({
    crmRestaurantId: body.crm_restaurant_id,
    restaurantName: body.restaurant_name ?? body.name,
  });
  if (resolved.error || !resolved.restaurant) {
    return NextResponse.json({ error: resolved.error ?? "could not resolve restaurant" }, { status: 400 });
  }
  const restaurant = resolved.restaurant;

  const admin = supabaseAdmin();
  if (Object.keys(settings).length) {
    const { error: settingsError } = await admin.from("restaurants").update(settings).eq("id", restaurant.id);
    if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 });
  }
  const wanted = requested.map((r) => String(r?.zuppler_restaurant_id ?? "").trim()).filter(Boolean);

  // Who already owns any of these ids, in either table.
  const existing: ExistingMapping[] = [];
  let currentPrimary: string | null = null;
  if (wanted.length) {
    const [{ data: linkRows }, { data: legacyRows }, { data: self }] = await Promise.all([
      admin
        .from("restaurant_zuppler_ids")
        .select("zuppler_restaurant_id, restaurant_id, restaurants(name)")
        .in("zuppler_restaurant_id", wanted),
      admin
        .from("restaurants")
        .select("id, name, zuppler_restaurant_id")
        .in("zuppler_restaurant_id", wanted),
      admin.from("restaurants").select("zuppler_restaurant_id").eq("id", restaurant.id).maybeSingle(),
    ]);
    for (const row of (linkRows ?? []) as any[]) {
      existing.push({
        zuppler_restaurant_id: row.zuppler_restaurant_id,
        restaurant_id: row.restaurant_id,
        restaurant_name: row.restaurants?.name ?? row.restaurant_id,
      });
    }
    for (const row of (legacyRows ?? []) as any[]) {
      existing.push({
        zuppler_restaurant_id: row.zuppler_restaurant_id,
        restaurant_id: row.id,
        restaurant_name: row.name,
      });
    }
    currentPrimary = (self as any)?.zuppler_restaurant_id ?? null;
  }

  // No listings is a valid call (E1's create-or-ensure with settings only);
  // the mapping rules apply only when there is something to map.
  if (wanted.length) {
    const outcome = planZupplerMapping({
      restaurantId: restaurant.id,
      currentPrimary,
      requested,
      existing,
    });
    if ("error" in outcome) {
      // A machine-readable code beside the sentence, so the CRM can offer
      // "link to that restaurant instead" rather than parsing prose.
      return NextResponse.json(
        { error: outcome.error, code: outcome.status === 409 ? "zuppler_id_conflict" : "invalid_zuppler_id" },
        { status: outcome.status }
      );
    }

    const { plan } = outcome;
    const { error: upsertError } = await admin
      .from("restaurant_zuppler_ids")
      .upsert(plan.upserts, { onConflict: "zuppler_restaurant_id" });
    if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

    if (plan.setPrimary) {
      const { error: primaryError } = await admin
        .from("restaurants")
        .update({ zuppler_restaurant_id: plan.setPrimary })
        .eq("id", restaurant.id);
      if (primaryError) return NextResponse.json({ error: primaryError.message }, { status: 500 });
    }
  }

  const { data: after } = await admin
    .from("restaurants")
    .select("id, name, crm_restaurant_id, zuppler_restaurant_id, is_active, app_expected, display_mode, timezone")
    .eq("id", restaurant.id)
    .single();
  const { data: afterIds } = await admin
    .from("restaurant_zuppler_ids")
    .select("zuppler_restaurant_id, label")
    .eq("restaurant_id", restaurant.id);

  return NextResponse.json({
    ok: true,
    restaurant_created: Boolean(resolved.created),
    warning: resolved.warning ?? null,
    restaurant: {
      ...after,
      zuppler_ids: zupplerIdsFor(
        after?.zuppler_restaurant_id ?? null,
        new Set((afterIds ?? []).map((r: any) => r.zuppler_restaurant_id))
      ),
      listings: (afterIds ?? []).map((r: any) => ({
        zuppler_restaurant_id: r.zuppler_restaurant_id,
        label: r.label ?? null,
      })),
    },
  });
}
