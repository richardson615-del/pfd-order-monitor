/**
 * What the bridge can truthfully say about a restaurant's tablet, for the CRM.
 *
 * The CRM stores no device data. It has a per-restaurant "tablet expected"
 * flag and, until now, nothing about whether the tablet is actually open,
 * hearing alerts, or on the current shell - all of which this database
 * already records on the dashboard's two-minute heartbeat. This is the
 * pure half of handing that over: one shape, every field nullable, and
 * `null` always meaning "no data", never a guess.
 */

/**
 * How recently a heartbeat has to have landed for the tablet to count as
 * online. The beat is every two minutes (HEARTBEAT_EVERY_MS); five minutes
 * allows one missed beat plus jitter. Health's own tablet_not_watching rule
 * waits fifteen - that one raises an alarm, this one colours a dot, and a
 * dot that lags the truth by a quarter of an hour is a dot nobody trusts.
 */
export const TABLET_ONLINE_WITHIN_MS = 5 * 60_000;

export function tabletOnline(lastSeenAt: string | null | undefined, now: number): boolean {
  if (!lastSeenAt) return false;
  const t = new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t <= TABLET_ONLINE_WITHIN_MS;
}

/** The alert gate's own states, as the dashboard reports them (lib/alert-gate.ts). */
export type TabletAlertState = "hidden" | "ask" | "blocked" | "unsupported";
const ALERT_STATES: ReadonlySet<unknown> = new Set<TabletAlertState>(["hidden", "ask", "blocked", "unsupported"]);

export interface HeartbeatRow {
  last_seen_at: string | null;
  user_agent?: string | null;
  push_subscribed?: boolean | null;
  shell_version?: number | null;
  alert_state?: string | null;
}

/** A kiosk_devices row (migration 036) bound to the restaurant. */
export interface KioskDeviceRow {
  device_ref: string;
  model?: string | null;
  last_seen_at?: string | null;
  bound_at?: string | null;
}

export interface TabletStatus {
  /** = restaurants.app_expected: is this site MEANT to be watching the tablet? */
  expected: boolean;
  /** dashboard_heartbeats.last_seen_at, or null when no screen has ever checked in. */
  last_seen_at: string | null;
  /** Server-computed: last_seen_at within TABLET_ONLINE_WITHIN_MS of now. */
  online: boolean;
  /** Latest heartbeat's own report; null when it has not said (older client, no row). */
  push_subscribed: boolean | null;
  /**
   * WHY the screen cannot ring, from the same heartbeat (migration 037):
   * "blocked" = the notification permission is denied, which on a Hexnode
   * kiosk means the notification policy is missing - the office fixes that
   * in the console, nobody at the store can. null = it has not said.
   */
  alert_state: TabletAlertState | null;
  /** Live rows in push_subscriptions for this restaurant. */
  push_subscriptions: number;
  /** appVersionCode of the Android shell the last beat came from; null when it has not said. */
  shell_version: number | null;
  display_mode: "kitchen" | "standard";
  user_agent: string | null;
  /**
   * Which physical unit is bound to this restaurant (kiosk_devices, I1):
   * the serial Hexnode put on the shell, or aid:<ANDROID_ID> when it
   * self-registered. When more than one is bound, the one that
   * bootstrapped most recently. null = no binding pushed yet.
   */
  device_ref: string | null;
  /** When that unit last bootstrapped against the bridge; null = never, or no binding. */
  device_seen_at: string | null;
  /** What the unit said it was on bootstrap; null when it did not say. Never identity. */
  device_model: string | null;
  /** How many units are bound to this restaurant. Two is a store that runs two. */
  device_count: number;
}

/**
 * Assemble the object from what the database holds. Missing heartbeat row →
 * every heartbeat-derived field null/false and `online` false; the counts
 * are still real. Nothing here infers a value from another value.
 */
export function tabletStatus(args: {
  expected: boolean;
  displayMode: unknown;
  heartbeat: HeartbeatRow | null | undefined;
  pushSubscriptions: number;
  /** kiosk_devices rows bound to this restaurant; omitted = none known. */
  kioskDevices?: KioskDeviceRow[] | null;
  now: number;
}): TabletStatus {
  const hb = args.heartbeat ?? null;
  const unit = latestKiosk(args.kioskDevices ?? []);
  return {
    expected: Boolean(args.expected),
    last_seen_at: hb?.last_seen_at ?? null,
    online: tabletOnline(hb?.last_seen_at, args.now),
    push_subscribed: typeof hb?.push_subscribed === "boolean" ? hb.push_subscribed : null,
    alert_state: ALERT_STATES.has(hb?.alert_state) ? (hb!.alert_state as TabletAlertState) : null,
    push_subscriptions: Number.isInteger(args.pushSubscriptions) && args.pushSubscriptions > 0 ? args.pushSubscriptions : 0,
    shell_version: typeof hb?.shell_version === "number" && Number.isInteger(hb.shell_version) ? hb.shell_version : null,
    display_mode: args.displayMode === "standard" ? "standard" : "kitchen",
    user_agent: hb?.user_agent ?? null,
    device_ref: unit?.device_ref ?? null,
    device_seen_at: unit?.last_seen_at ?? null,
    device_model: unit?.model ?? null,
    device_count: (args.kioskDevices ?? []).filter((k) => k?.device_ref).length,
  };
}

/** The bound unit that bootstrapped most recently; one that never has sorts last. */
function latestKiosk(rows: KioskDeviceRow[]): KioskDeviceRow | null {
  let best: KioskDeviceRow | null = null;
  for (const k of rows) {
    if (!k?.device_ref) continue;
    if (!best) {
      best = k;
      continue;
    }
    const a = k.last_seen_at ? Date.parse(k.last_seen_at) : -1;
    const b = best.last_seen_at ? Date.parse(best.last_seen_at) : -1;
    if (a > b) best = k;
  }
  return best;
}
