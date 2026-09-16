import { supabaseAdmin } from "./supabase-server";
import { DEFAULT_FOOTER_TEXT } from "./ticket";
import { orderDestinations } from "./canonical";
import { tabletStatus, type HeartbeatRow, type KioskDeviceRow, type TabletStatus } from "./tablet-status";

/**
 * One restaurant row, as the CRM sees it - built in one place so the
 * roster (GET /api/crm/restaurants), the single record (GET
 * /api/crm/restaurants/:id) and the issues feed cannot describe the same
 * tablet three different ways. Every derived field is computed here and
 * relayed by the CRM; the contract (docs/crm-bridge-contract.md) is the
 * list of fields below, so a change here is a change there.
 */

/** The columns every CRM-facing read selects. One string, so the three routes cannot drift. */
export const RESTAURANT_SELECT =
  "id, name, is_active, zuppler_restaurant_id, crm_restaurant_id, ticket_footer_text, ticket_footer_url, ticket_text_scale, ticket_design_style, ticket_footer_mode, ticket_logo_b64, ticket_footer_image_b64, footer_engine, footer_template_id, footer_template_config, order_counter, print_method, ticket_email_to, app_expected, display_mode, timezone";

/** Everything a row needs from other tables, read once for however many rows are being shaped. */
export interface RosterContext {
  now: number;
  withPrinter: Set<string>;
  idsByRestaurant: Map<string, Set<string>>;
  heartbeatByRestaurant: Map<string, HeartbeatRow>;
  pushCount: Map<string, number>;
  kioskByRestaurant: Map<string, KioskDeviceRow[]>;
}

/**
 * Read the side tables for a set of restaurants (or the whole roster when
 * `restaurantIds` is omitted). Whole-table reads, filtered in memory: the
 * roster asks for everyone at once, and the per-restaurant tables are one
 * row per restaurant, so a filter buys nothing and a second query shape
 * is one more thing to keep equal.
 */
export async function loadRosterContext(restaurantIds?: string[]): Promise<RosterContext> {
  const admin = supabaseAdmin();
  const only = restaurantIds ? new Set(restaurantIds) : null;
  const keep = (id: string) => !only || only.has(id);

  const [{ data: deviceRows }, { data: idRows }, { data: heartbeatRows }, { data: pushRows }, { data: kioskRows }] =
    await Promise.all([
      // Who actually has a working printer - asked of print_devices rather
      // than of printer_expected; see orderDestinations() for why that flag
      // cannot answer this.
      admin.from("print_devices").select("restaurant_id").eq("is_active", true),
      // Every Zuppler listing each restaurant owns, so the console can see
      // which of an account's listings are mapped and which will be dropped.
      admin.from("restaurant_zuppler_ids").select("restaurant_id, zuppler_restaurant_id"),
      // What each restaurant's tablet last said (migrations 024/030/033/037).
      admin
        .from("dashboard_heartbeats")
        .select("restaurant_id, last_seen_at, user_agent, push_subscribed, shell_version, alert_state"),
      // How many browsers can ring for it.
      admin.from("push_subscriptions").select("restaurant_id"),
      // Which physical kiosk is bound to it (migration 036): the device
      // reference Hexnode put on the shell, or aid:<ANDROID_ID>.
      admin
        .from("kiosk_devices")
        .select("device_ref, restaurant_id, model, last_seen_at, bound_at")
        .not("restaurant_id", "is", null),
    ]);

  const withPrinter = new Set<string>();
  for (const d of (deviceRows ?? []) as any[]) if (keep(d.restaurant_id)) withPrinter.add(d.restaurant_id);

  const idsByRestaurant = new Map<string, Set<string>>();
  for (const row of (idRows ?? []) as any[]) {
    if (!keep(row.restaurant_id)) continue;
    const set = idsByRestaurant.get(row.restaurant_id) ?? new Set<string>();
    set.add(row.zuppler_restaurant_id);
    idsByRestaurant.set(row.restaurant_id, set);
  }

  const heartbeatByRestaurant = new Map<string, HeartbeatRow>();
  for (const h of (heartbeatRows ?? []) as any[]) if (keep(h.restaurant_id)) heartbeatByRestaurant.set(h.restaurant_id, h);

  const pushCount = new Map<string, number>();
  for (const p of (pushRows ?? []) as any[]) {
    if (!keep(p.restaurant_id)) continue;
    pushCount.set(p.restaurant_id, (pushCount.get(p.restaurant_id) ?? 0) + 1);
  }

  const kioskByRestaurant = new Map<string, KioskDeviceRow[]>();
  for (const k of (kioskRows ?? []) as any[]) {
    if (!keep(k.restaurant_id)) continue;
    const list = kioskByRestaurant.get(k.restaurant_id) ?? [];
    list.push(k);
    kioskByRestaurant.set(k.restaurant_id, list);
  }

  return { now: Date.now(), withPrinter, idsByRestaurant, heartbeatByRestaurant, pushCount, kioskByRestaurant };
}

/** The tablet object alone, for callers (the issues feed) that do not need the whole row. */
export function tabletFor(r: { id: string; app_expected?: boolean | null; display_mode?: unknown }, ctx: RosterContext): TabletStatus {
  return tabletStatus({
    expected: Boolean(r.app_expected),
    displayMode: r.display_mode,
    heartbeat: ctx.heartbeatByRestaurant.get(r.id),
    pushSubscriptions: ctx.pushCount.get(r.id) ?? 0,
    kioskDevices: ctx.kioskByRestaurant.get(r.id) ?? [],
    now: ctx.now,
  });
}

export function shapeRestaurantRow(r: any, ctx: RosterContext) {
  // Images are returned as presence + size, never inline. A roster call
  // that shipped every logo would be megabytes for a list view, and the
  // console only needs to know whether one is set.
  const { ticket_logo_b64, ticket_footer_image_b64, ...rest } = r;
  return {
    ...rest,
    has_logo: Boolean(ticket_logo_b64),
    logo_bytes: ticket_logo_b64 ? Buffer.from(ticket_logo_b64, "base64").length : 0,
    has_footer_image: Boolean(ticket_footer_image_b64),
    effective_footer_text: (r.ticket_footer_text ?? "").trim() || DEFAULT_FOOTER_TEXT,
    prints_qr: r.ticket_footer_mode === "qr_with_text" && Boolean(r.ticket_footer_url),
    // Surfaced so the console can show a misconfiguration before an order
    // arrives, rather than after a ticket fails to reach anyone.
    email_delivery_ready: r.print_method !== "email" || Boolean((r.ticket_email_to ?? "").trim()),
    has_active_printer: ctx.withPrinter.has(r.id),
    // Which of the two looks their tablet is on, so the CRM can show the
    // current setting rather than guessing at a default.
    display_mode: r.display_mode ?? "kitchen",
    // Which clock their tablet shows. Null = the device's own time.
    timezone: r.timezone ?? null,
    // Both mapping tables, primary first. Ingest honours both.
    zuppler_ids: zupplerIdsFor(r.zuppler_restaurant_id, ctx.idsByRestaurant.get(r.id)),
    // Whether the tablet is open, hearing alerts, on which shell, and which
    // physical unit - from the dashboard's own heartbeat and the kiosk
    // binding. Every field nullable, and null means "no data", never a
    // guess. See lib/tablet-status.ts.
    tablet: tabletFor(r, ctx),
    // The straight answer to "where do this restaurant's orders go?".
    // Computed here so the console never has to re-derive it from three
    // columns and get a different answer than the ingest does. An empty
    // list means orders arrive and nobody there is told.
    destinations: orderDestinations({
      print_method: r.print_method,
      app_expected: r.app_expected,
      hasActivePrinter: ctx.withPrinter.has(r.id),
    }),
  };
}

export function zupplerIdsFor(primary: string | null, extra: Set<string> | undefined): string[] {
  const out: string[] = [];
  if (primary) out.push(primary);
  for (const id of extra ?? []) if (!out.includes(id)) out.push(id);
  return out;
}
