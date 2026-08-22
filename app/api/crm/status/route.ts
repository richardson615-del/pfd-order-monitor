import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/status?zuppler_restaurant_id=... | ?restaurant_id=...
 * Authorization: Bearer <CRM_STATUS_READ_KEY>
 *
 * Read-only per-restaurant slice of the same operational data
 * lib/health.ts's collectSnapshot() computes for the internal alerting
 * job -- deliberately reusing that data shape rather than inventing a
 * second one, so this and /api/monitor/check can never silently drift
 * apart on what "healthy" means. A dedicated key, not CRON_SECRET or
 * ZUPPLER_WEBHOOK_SECRET -- each caller gets its own, same reasoning as
 * every other secret in this system (see .env.example).
 *
 * Built for prs-crm's Order Monitor fold-in: the onboarding record view
 * shows this restaurant's printer/inbox/print-job health instead of
 * "open the Order Monitor admin panel and go look." zuppler_restaurant_id
 * is the natural join key -- it's what the CRM already stores
 * (onboarding_records.zuppler_restaurant_id, migration 0050) and what a
 * restaurant is actually identified by in both systems; restaurant_id
 * (this system's own UUID) is accepted too for admin tooling that
 * already has it.
 */
export async function GET(req: NextRequest) {
  const key = process.env.CRM_STATUS_READ_KEY;
  const auth = req.headers.get("authorization");
  if (!key || auth !== `Bearer ${key}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const zupplerRestaurantId = req.nextUrl.searchParams.get("zuppler_restaurant_id");
  const restaurantId = req.nextUrl.searchParams.get("restaurant_id");
  if (!zupplerRestaurantId && !restaurantId) {
    return NextResponse.json(
      { error: "zuppler_restaurant_id or restaurant_id is required" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  let restaurantQuery = admin
    .from("restaurants")
    .select("id, name, is_active, zuppler_restaurant_id");
  restaurantQuery = zupplerRestaurantId
    ? restaurantQuery.eq("zuppler_restaurant_id", zupplerRestaurantId)
    : restaurantQuery.eq("id", restaurantId as string);

  const { data: restaurant, error: restaurantError } = await restaurantQuery.maybeSingle();
  if (restaurantError) {
    return NextResponse.json({ error: restaurantError.message }, { status: 500 });
  }
  if (!restaurant) {
    return NextResponse.json({ error: "no restaurant mapped to that id" }, { status: 404 });
  }

  const [devicesRes, inboxesRes, jobsRes, pushRes] = await Promise.all([
    admin
      .from("print_devices")
      .select("id, name, is_active, last_seen_at, printer_name, app_version")
      .eq("restaurant_id", restaurant.id),
    admin
      .from("monitored_inboxes")
      .select("id, email_address, is_active, gmail_refresh_token, gmail_last_poll_at")
      .eq("restaurant_id", restaurant.id),
    // Only recent jobs -- an old failed/queued row from before a device was
    // fixed or replaced is not "current status," it's history. print_jobs has
    // no restaurant_id column of its own (see migration 002); joining through
    // orders is the only path to it.
    admin
      .from("print_jobs")
      .select("status, orders!inner(restaurant_id)")
      .eq("orders.restaurant_id", restaurant.id)
      .in("status", ["queued", "claimed", "failed"]),
    // The app path's only real signal today: a row means the PWA was
    // installed and subscribed on some device. There is no delivery-receipt
    // tracking anywhere in this schema yet, so "last notification delivered"
    // is deliberately NOT claimed here -- count only, not a health verdict.
    admin
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurant.id),
  ]);

  if (devicesRes.error) return NextResponse.json({ error: devicesRes.error.message }, { status: 500 });
  if (inboxesRes.error) return NextResponse.json({ error: inboxesRes.error.message }, { status: 500 });
  if (jobsRes.error) return NextResponse.json({ error: jobsRes.error.message }, { status: 500 });
  if (pushRes.error) return NextResponse.json({ error: pushRes.error.message }, { status: 500 });

  const jobs = jobsRes.data ?? [];

  return NextResponse.json({
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      is_active: restaurant.is_active,
      zuppler_restaurant_id: restaurant.zuppler_restaurant_id,
    },
    devices: (devicesRes.data ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      is_active: d.is_active,
      last_seen_at: d.last_seen_at,
      printer_name: d.printer_name,
      app_version: d.app_version,
    })),
    inboxes: (inboxesRes.data ?? []).map((i) => ({
      id: i.id,
      email_address: i.email_address,
      is_active: i.is_active,
      has_token: !!i.gmail_refresh_token,
      last_poll_at: i.gmail_last_poll_at,
    })),
    print_jobs: {
      pending: jobs.filter((j) => j.status === "queued" || j.status === "claimed").length,
      failed: jobs.filter((j) => j.status === "failed").length,
    },
    push_subscriptions_count: pushRes.count ?? 0,
  });
}
