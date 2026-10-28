import type { HealthIssue, IssueSeverity } from "./health";
import { READY_MINUTE_CHOICES } from "./ready-timer";

/**
 * Alerts on the restaurant's own tablet (KT1, prs-crm Ticket #779, Nick
 * 2026-10-28: "show alerts on the restaurant's tablet").
 *
 * The same findings the CRM reads from GET /api/crm/issues (evaluateHealth),
 * cut down to the ones about THIS restaurant and that the kitchen can do
 * something about, in the kitchen's words. An allow-list on purpose: a new
 * health check stays staff-only until someone decides what the kitchen
 * should read. Left out: an unopened order (it is already on the screen,
 * chiming), "nobody watching the tablet" (they are looking at it), and
 * order-volume findings (a business question for PFD, not the kitchen).
 * No ticket numbers, no device ids.
 *
 * DM1 in the CRM (device alerts off) stops tickets and bells for staff; it
 * does not reach this list. Not built: texts or emails to the restaurant
 * (Nick 2026-10-28) - this list, the banner and dispatch's tablet message
 * cover it.
 *
 * Pure: the route and the tests share it.
 */

export interface KitchenAlert {
  key: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  /** When the five-minute monitor first saw it; null until that run has stamped it. */
  since: string | null;
}

type Words = (issue: HealthIssue) => { title: string; detail: string };

/** Key prefix -> the kitchen's words. Anything not here is not shown. */
const KITCHEN_WORDS: Record<string, Words> = {
  device_silent: () => ({
    title: "Printer offline - orders are not printing",
    detail: "Check the printer's power, its network cable and its paper. Orders still show here on the tablet.",
  }),
  device_never_seen: () => ({
    title: "Printer not connected yet",
    detail: "A printer is set up for you but has never connected. Call Premium dispatch to finish setting it up.",
  }),
  restaurant_no_device: () => ({
    title: "No printer connected",
    detail: "Orders show here on the tablet but will not print. Call Premium dispatch if you expect a printer.",
  }),
  // The stored print error is already plain English (lib/print-policy.ts), e.g. "Printer is out of paper: order 1196".
  job_stuck: (i) => ({
    title: i.title,
    detail: i.order?.order_number ? `Order ${i.order.order_number} has not printed yet. It prints by itself once the printer is fixed; the order is on the tablet meanwhile.` : "A ticket has not printed yet. It prints by itself once the printer is fixed.",
  }),
  job_failed: (i) => ({
    title: i.title,
    detail: i.order?.order_number ? `Order ${i.order.order_number} did not print. Use the order on the tablet, and reprint it from there once the printer is fixed.` : "A ticket did not print. Use the order on the tablet.",
  }),
  restaurant_no_app_device: () => ({
    title: "Order notifications are off on this tablet",
    detail: 'New orders will not chime. Tap "Enable notifications" on this screen, or call Premium dispatch.',
  }),
};

const prefixOf = (key: string) => key.split(":")[0] ?? key;

/** This restaurant's alerts, critical first, in the kitchen's words. `firstSeen` is monitor_alerts.first_seen_at by key. */
export function kitchenAlerts(issues: HealthIssue[], restaurantId: string, firstSeen: Map<string, string | null> = new Map()): KitchenAlert[] {
  const out: KitchenAlert[] = [];
  for (const i of issues) {
    if (!i.restaurant_id || i.restaurant_id !== restaurantId) continue;
    const words = KITCHEN_WORDS[prefixOf(i.key)];
    if (!words) continue;
    out.push({ key: i.key, severity: i.severity, ...words(i), since: firstSeen.get(i.key) ?? null });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

/** The one line over the orders while a critical alert is open, or null. Several criticals read as the first plus a count. */
export function kitchenAlertBanner(alerts: KitchenAlert[]): string | null {
  const critical = alerts.filter((a) => a.severity === "critical");
  if (!critical.length) return null;
  const more = critical.length - 1;
  return more > 0 ? `${critical[0]!.title} (and ${more} more - see Store)` : critical[0]!.title;
}

// --- default cook time --------------------------------------------------------

/** The cook-time choices on the Store tab: the same quick picks as Accept. */
export const COOK_TIME_CHOICES: readonly number[] = READY_MINUTE_CHOICES;

/** What the kitchen may store as its default cook time (restaurants.prep_minutes): one of the Accept quick picks. */
export function parseCookTime(input: unknown): { kind: "ok"; minutes: number } | { kind: "error"; error: string } {
  const v = (input ?? {}) as Record<string, unknown>;
  const m = v.prep_minutes;
  if (typeof m !== "number" || !COOK_TIME_CHOICES.includes(m)) return { kind: "error", error: `Pick a cook time: ${COOK_TIME_CHOICES.join(", ")} minutes.` };
  return { kind: "ok", minutes: m };
}
