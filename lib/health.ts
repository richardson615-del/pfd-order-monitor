/**
 * Health checks for the order pipeline.
 *
 * Every failure this system has produced has been silent: an order reaching
 * the dashboard and never printing, a Gmail token dying, a poll window
 * quietly dropping a message, a printer that stopped checking in. The
 * dashboard shows all of it - but only to someone who happens to look.
 *
 * evaluateHealth() is deliberately pure: it takes a snapshot and a clock and
 * returns issues. That means the alerting rules can be tested exhaustively
 * without a database, which matters because an alerting system that is wrong
 * is worse than none - it either cries wolf until people mute it, or stays
 * quiet during the outage it existed to catch.
 */

export type IssueSeverity = "critical" | "warning";

export interface HealthIssue {
  /** Stable identity for this problem, so repeats are not re-alerted. */
  key: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
}

export interface HealthSnapshot {
  devices: {
    id: string;
    name: string;
    restaurant_name: string | null;
    is_active: boolean;
    last_seen_at: string | null;
  }[];
  inboxes: {
    id: string;
    email_address: string;
    restaurant_name: string | null;
    is_active: boolean;
    has_token: boolean;
    last_poll_at: string | null;
  }[];
  /** Restaurants that can receive orders but have no active printer. */
  restaurantsWithoutDevice: { id: string; name: string }[];
  /** Print jobs queued or claimed but not finished. */
  pendingJobs: {
    id: string;
    order_number: string | null;
    restaurant_name: string | null;
    queued_at: string;
    status: string;
    attempts: number;
  }[];
  /** Jobs parked as failed after exhausting retries. */
  failedJobs: {
    id: string;
    order_number: string | null;
    restaurant_name: string | null;
    error: string | null;
  }[];
  /**
   * The inbound order webhook. Nothing watched this until 2026-08-27, when
   * two receipts arrived, were rejected, and produced no orders - and no
   * check anywhere could tell that from a quiet morning.
   */
  /** Email-delivery tickets that were never actually sent. */
  unsentEmailJobs: {
    id: string;
    order_number: string | null;
    restaurant_name: string | null;
    queued_at: string;
    send_error: string | null;
  }[];
  /** Orders whose captured money fields do not sum to the charged total. */
  unreconciledOrders: {
    id: string;
    order_number: string | null;
    restaurant_name: string | null;
    variance: number;
  }[];
  webhook: {
    /** Newest receipt of any kind, accepted or rejected. */
    lastReceiptAt: string | null;
    /** Newest receipt that actually became an order. */
    lastAcceptedAt: string | null;
    /** Receipts inside the recent window, and how many were turned away. */
    recentTotal: number;
    recentRejected: number;
  };
}

export interface HealthThresholds {
  /** A device polls every few seconds; this much silence means it is down. */
  deviceSilentMinutes: number;
  /** Gmail is polled every minute; this much silence means polling stopped. */
  inboxSilentMinutes: number;
  /** A ticket should print within seconds. This long means it never will. */
  jobPendingMinutes: number;
  /** No accepted webhook order for this long means the pipe may be dead. */
  webhookSilentHours: number;
  /** An email ticket unsent this long has not been delayed, it has failed. */
  emailUnsentMinutes: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  // Generous relative to the real cadence (seconds), because a brief network
  // blip is not an outage and an alert that fires on those gets muted.
  deviceSilentMinutes: 15,
  inboxSilentMinutes: 15,
  jobPendingMinutes: 10,
  // Long on purpose. Restaurants close, and a quiet night is not an outage -
  // an alert that fires every morning at 4am is one nobody reads.
  webhookSilentHours: 24,
  // The send is synchronous with ingest, so anything still unsent after this
  // is not slow - it never went.
  emailUnsentMinutes: 5,
};

const minutesSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 60000);
};

const ago = (mins: number | null): string =>
  mins === null ? "never"
  : mins < 60 ? `${mins} min ago`
  : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
  : `${Math.floor(mins / 1440)}d ago`;

/** Pure: snapshot + clock -> the problems worth waking someone for. */
export function evaluateHealth(
  snap: HealthSnapshot,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS
): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const where = (name: string | null) => name ?? "unknown restaurant";

  // --- printers that stopped checking in ---
  for (const d of snap.devices) {
    if (!d.is_active) continue;
    const mins = minutesSince(d.last_seen_at, now);
    if (mins === null) {
      issues.push({
        key: `device_never_seen:${d.id}`,
        severity: "warning",
        title: `Printer never checked in: ${d.name}`,
        detail: `${where(d.restaurant_name)} - registered but has never contacted the server. Finish the printer's Direct Print setup, or deactivate the device.`,
      });
    } else if (mins >= thresholds.deviceSilentMinutes) {
      issues.push({
        key: `device_silent:${d.id}`,
        severity: "critical",
        title: `Printer offline: ${d.name}`,
        detail: `${where(d.restaurant_name)} - last checked in ${ago(mins)}. Orders will not print. Check power, network and paper.`,
      });
    }
  }

  // --- email tickets that never sent ---
  // CRITICAL, and the only check here that pages. For an AEM restaurant the
  // email IS the ticket: no queued job waits on a printer that might come
  // back, and nobody at the restaurant sees anything at all. It is the exact
  // equivalent of a printer being offline mid-service.
  const unsent = snap.unsentEmailJobs.filter((j) => {
    const mins = minutesSince(j.queued_at, now);
    return mins !== null && mins >= thresholds.emailUnsentMinutes;
  });
  if (unsent.length) {
    const oldest = unsent.reduce((a, b) =>
      new Date(a.queued_at) <= new Date(b.queued_at) ? a : b
    );
    const reason = unsent.find((j) => j.send_error)?.send_error;
    issues.push({
      key: "email_send_failed",
      severity: "critical",
      title: `${unsent.length} ticket(s) not emailed to the restaurant`,
      detail:
        `Order ${oldest.order_number ?? oldest.id} for ${oldest.restaurant_name ?? "unknown"} has been waiting ${ago(minutesSince(oldest.queued_at, now))} and never sent. ` +
        `This restaurant prints by email - nobody there has seen this order.` +
        (reason ? ` Last error: ${reason}` : ""),
    });
  }

  // --- money that does not add up ---
  // A warning, never a page: nothing is broken for the kitchen, and the
  // customer was charged what Zuppler says. What it means is that a money
  // field is arriving that we are not capturing - which stays invisible
  // until someone disputes a statement months later.
  if (snap.unreconciledOrders.length) {
    const worst = snap.unreconciledOrders
      .slice()
      .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))[0];
    issues.push({
      key: "orders_unreconciled",
      severity: "warning",
      title: `${snap.unreconciledOrders.length} order(s) with unexplained money`,
      detail:
        `Components do not sum to the charged total - largest gap $${Math.abs(worst.variance).toFixed(2)} on order ${worst.order_number ?? worst.id} (${worst.restaurant_name ?? "unknown"}). ` +
        `Zuppler is likely sending a money field we do not capture. Accounting figures built on the component columns will be wrong by this amount.`,
    });
  }

  // --- the inbound webhook ---
  // Only meaningful once the webhook has ever worked: before go-live,
  // silence is the expected state, not a fault worth reporting nightly.
  const w = snap.webhook;
  if (w.lastReceiptAt) {
    if (w.recentTotal > 0 && w.recentRejected === w.recentTotal) {
      // The expensive case. Something IS sending and we are refusing all of
      // it, which from the outside is indistinguishable from nobody sending -
      // and every one of those refusals is an order nobody will cook.
      issues.push({
        key: "webhook_all_rejected",
        severity: "critical",
        title: `Order webhook rejecting everything (${w.recentRejected} received, 0 accepted)`,
        detail:
          "Zuppler is delivering and every receipt is being turned away - most likely a token mismatch or an unmapped restaurant. Each one is a live order that will not print. Check webhook_receipts for the reason.",
      });
    } else if (w.lastAcceptedAt === null) {
      issues.push({
        key: "webhook_never_accepted",
        severity: "critical",
        title: "Order webhook has never accepted a delivery",
        detail:
          "Receipts have arrived but none has ever become an order. Check webhook_receipts for the rejection reason.",
      });
    } else {
      const mins = minutesSince(w.lastAcceptedAt, now);
      if (mins !== null && mins >= thresholds.webhookSilentHours * 60) {
        issues.push({
          key: "webhook_silent",
          severity: "warning",
          title: "No orders via the Zuppler webhook",
          detail: `Last accepted webhook order ${ago(mins)}. If restaurants are taking orders, the channel may have stopped delivering.`,
        });
      }
    }
  }

  // --- inboxes that stopped being polled ---
  for (const i of snap.inboxes) {
    if (!i.is_active) continue;
    if (!i.has_token) {
      issues.push({
        key: `inbox_disconnected:${i.id}`,
        severity: "critical",
        title: `Inbox not connected: ${i.email_address}`,
        detail: `${where(i.restaurant_name)} - active but has no Gmail access, so nothing is being read. Reconnect it in the admin panel.`,
      });
      continue;
    }
    const mins = minutesSince(i.last_poll_at, now);
    if (mins === null || mins >= thresholds.inboxSilentMinutes) {
      issues.push({
        key: `inbox_stalled:${i.id}`,
        severity: "critical",
        title: `Inbox not polling: ${i.email_address}`,
        detail: `${where(i.restaurant_name)} - last successful poll ${ago(mins)}. Orders arriving by email are not being picked up. Usually expired Gmail access.`,
      });
    }
  }

  // --- restaurants that can take orders but cannot print them ---
  for (const r of snap.restaurantsWithoutDevice) {
    issues.push({
      key: `restaurant_no_device:${r.id}`,
      severity: "warning",
      title: `No printer: ${r.name}`,
      detail: `Orders for ${r.name} will be recorded but never printed - no active print device is registered.`,
    });
  }

  // --- tickets that should have printed by now ---
  for (const j of snap.pendingJobs) {
    const mins = minutesSince(j.queued_at, now);
    if (mins !== null && mins >= thresholds.jobPendingMinutes) {
      issues.push({
        key: `job_stuck:${j.id}`,
        severity: "critical",
        title: `Ticket not printed: order ${j.order_number ?? "?"}`,
        detail: `${where(j.restaurant_name)} - queued ${ago(mins)} and still ${j.status} after ${j.attempts} attempt(s).`,
      });
    }
  }

  // --- tickets that gave up ---
  for (const j of snap.failedJobs) {
    issues.push({
      key: `job_failed:${j.id}`,
      severity: "critical",
      title: `Ticket failed to print: order ${j.order_number ?? "?"}`,
      detail: `${where(j.restaurant_name)} - gave up after 3 attempts${j.error ? `: ${j.error}` : ""}.`,
    });
  }

  return issues;
}

/** Critical first, then warnings - both already in a stable per-check order. */
export function sortIssues(issues: HealthIssue[]): HealthIssue[] {
  return [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1
  );
}

// ---------------------------------------------------------------------------
// Database side. Kept below the pure logic on purpose: everything above is
// testable without a database, and this is the only part that needs one.
// ---------------------------------------------------------------------------

import { supabaseAdmin } from "./supabase-server";
import { ACCEPTED_STATUSES } from "./webhook-receipts";

/** Reads the current state of the pipeline for evaluateHealth(). */
export async function collectSnapshot(): Promise<HealthSnapshot> {
  const admin = supabaseAdmin();

  const [devicesRes, inboxesRes, restaurantsRes, jobsRes] = await Promise.all([
    admin.from("print_devices").select("id, name, is_active, last_seen_at, restaurant_id"),
    admin.from("monitored_inboxes").select("id, email_address, is_active, gmail_refresh_token, gmail_last_poll_at, restaurant_id"),
    admin.from("restaurants").select("id, name, is_active, zuppler_restaurant_id, printer_expected, print_method"),
    admin
      .from("print_jobs")
      .select("id, status, attempts, queued_at, error, orders(order_number, restaurant_id)")
      .in("status", ["queued", "claimed", "failed"]),
  ]);

  // Recent window for the "arriving but all rejected" check. Wide enough to
  // survive a quiet stretch, short enough that yesterday's fixed problem does
  // not keep firing today.
  const recentSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const [lastReceiptRes, lastAcceptedRes, recentRes] = await Promise.all([
    admin.from("webhook_receipts").select("received_at")
      .order("received_at", { ascending: false }).limit(1),
    admin.from("webhook_receipts").select("received_at")
      .in("status", ACCEPTED_STATUSES)
      .order("received_at", { ascending: false }).limit(1),
    admin.from("webhook_receipts").select("status")
      .gte("received_at", recentSince),
  ]);
  const recent = recentRes.data ?? [];
  const webhook = {
    lastReceiptAt: lastReceiptRes.data?.[0]?.received_at ?? null,
    lastAcceptedAt: lastAcceptedRes.data?.[0]?.received_at ?? null,
    recentTotal: recent.length,
    recentRejected: recent.filter(
      (r: any) => !ACCEPTED_STATUSES.includes(r.status)
    ).length,
  };

  // Recent window only: a historic gap that has been explained should not
  // keep warning, and the tripwire exists to catch NEW capture failures.
  const { data: unsentRows } = await admin
    .from("print_jobs")
    .select("id, queued_at, send_error, orders(order_number, restaurants(name))")
    .eq("delivery", "email")
    .is("sent_at", null)
    .neq("status", "failed_acknowledged")
    .order("queued_at", { ascending: true })
    .limit(50);
  const unsentEmailJobs = (unsentRows ?? []).map((j: any) => ({
    id: j.id,
    order_number: j.orders?.order_number ?? null,
    restaurant_name: j.orders?.restaurants?.name ?? null,
    queued_at: j.queued_at,
    send_error: j.send_error ?? null,
  }));

  const varianceSince = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: unreconciled } = await admin
    .from("orders")
    .select("id, order_number, money_variance, restaurants(name)")
    .neq("money_variance", 0)
    .not("money_variance", "is", null)
    .gte("received_at", varianceSince)
    .limit(50);
  const unreconciledOrders = (unreconciled ?? []).map((o: any) => ({
    id: o.id,
    order_number: o.order_number ?? null,
    restaurant_name: o.restaurants?.name ?? null,
    variance: Number(o.money_variance),
  }));

  const restaurants = restaurantsRes.data ?? [];
  const nameOf = (id: string | null) =>
    restaurants.find((r: any) => r.id === id)?.name ?? null;

  const devices = (devicesRes.data ?? []).map((d: any) => ({
    id: d.id,
    name: d.name,
    restaurant_name: nameOf(d.restaurant_id),
    is_active: d.is_active,
    last_seen_at: d.last_seen_at,
  }));

  const inboxes = (inboxesRes.data ?? []).map((i: any) => ({
    id: i.id,
    email_address: i.email_address,
    restaurant_name: nameOf(i.restaurant_id),
    is_active: i.is_active,
    has_token: !!i.gmail_refresh_token,
    last_poll_at: i.gmail_last_poll_at,
  }));

  // A restaurant is only MISSING a printer if it was meant to have one.
  //
  // Mapping the delivery channel brings in hundreds of restaurants - chains,
  // liquor stores, grocery pickup - that take orders through PFD and will
  // never print a ticket. Flagging each of them would put dozens of standing
  // warnings in front of whoever is looking for the one that matters, which
  // is how a monitoring surface stops being read at all.
  //
  // printer_expected is set when a restaurant is being onboarded for
  // printing, so this stays a short list of real gaps.
  const activeDeviceRestaurantIds = new Set(
    (devicesRes.data ?? []).filter((d: any) => d.is_active).map((d: any) => d.restaurant_id)
  );
  const inboxRestaurantIds = new Set(
    (inboxesRes.data ?? []).filter((i: any) => i.is_active).map((i: any) => i.restaurant_id)
  );
  const restaurantsWithoutDevice = restaurants
    .filter((r: any) => r.is_active)
    .filter((r: any) => r.printer_expected)
    // An email restaurant has no printer BY DESIGN. printer_expected already
    // gates this, but print_method makes the intent explicit and survives
    // someone setting printer_expected by hand.
    .filter((r: any) => r.print_method !== "email")
    .filter((r: any) => !activeDeviceRestaurantIds.has(r.id))
    .map((r: any) => ({ id: r.id, name: r.name }));

  const allJobs = jobsRes.data ?? [];
  const jobShape = (j: any) => ({
    id: j.id,
    order_number: j.orders?.order_number ?? null,
    restaurant_name: nameOf(j.orders?.restaurant_id ?? null),
  });

  return {
    unsentEmailJobs,
    unreconciledOrders,
    webhook,
    devices,
    inboxes,
    restaurantsWithoutDevice,
    pendingJobs: allJobs
      .filter((j: any) => j.status === "queued" || j.status === "claimed")
      .map((j: any) => ({ ...jobShape(j), queued_at: j.queued_at, status: j.status, attempts: j.attempts ?? 0 })),
    failedJobs: allJobs
      .filter((j: any) => j.status === "failed")
      .map((j: any) => ({ ...jobShape(j), error: j.error ?? null })),
  };
}
