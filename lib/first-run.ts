/**
 * The first run of a tablet at a store, and the screens around it.
 *
 * Nick, 2026-09-16 (after the Hexnode call): the restaurant touches nothing
 * but the kiosk's own Wi-Fi button - which Hexnode draws, not this app. No
 * login, no pairing, no toggles. The tablet is bound to its restaurant
 * before it ships (managed configuration) or on first boot (self
 * registration), and the office links it by code if both fail. So there
 * are exactly three things a tablet can be showing before the order list,
 * and the decision between them is pure:
 *
 *   pairing  - connectivity, but no valid session (unbound, or lost)
 *   ready    - connectivity and a session, first time on this device
 *   orders   - everything after that
 *
 * With no network at all the app cannot load; the service worker serves
 * public/offline.html, which says so and points at the kiosk's Wi-Fi
 * button. There is deliberately no Wi-Fi state here and no Wi-Fi UI
 * anywhere in the app - a web page cannot join a network, and the kiosk
 * already has the button that can.
 */

export type FirstRunScreen = "pairing" | "ready" | "orders";

export function firstRunScreen(args: { sessionValid: boolean; setupDone: boolean }): FirstRunScreen {
  if (!args.sessionValid) return "pairing";
  if (!args.setupDone) return "ready";
  return "orders";
}

/**
 * The three checks on the Ready screen, each read from real state, never
 * assumed. A row whose fact is unknown says so rather than showing a tick -
 * "Data missing" is Nick's standing rule.
 */
export interface ReadyCheck {
  key: "online" | "alerts" | "printer";
  label: string;
  /** true = tick, false = needs doing, null = not known yet */
  ok: boolean | null;
  /** What to do when it is false, in the restaurant's words. */
  action: string | null;
}

/** The one place the kiosk's own control is named. Hexnode draws it; we point at it. */
export const KIOSK_WIFI_HINT = "To change networks, use the Wi-Fi button at the bottom of the screen.";

export function readyChecks(args: {
  online: boolean;
  /** AlertGate's answer: subscribed and permitted. null = still reading. */
  alertsOn: boolean | null;
  /**
   * From the bridge's own view of the restaurant's printers. null when the
   * restaurant has no printer at all - the row is omitted, not ticked.
   */
  printer: { online: boolean | null } | null;
}): ReadyCheck[] {
  const rows: ReadyCheck[] = [
    {
      key: "online",
      label: "Connected to Premium",
      ok: args.online,
      action: args.online ? null : KIOSK_WIFI_HINT,
    },
    {
      key: "alerts",
      label: "Order alerts on",
      ok: args.alertsOn,
      action: args.alertsOn === false ? "Tap Turn on alerts — it only has to be done once." : null,
    },
  ];
  if (args.printer) {
    rows.push({
      key: "printer",
      label: "Kitchen printer online",
      ok: args.printer.online,
      action:
        args.printer.online === false
          ? "Check the printer is on and plugged into the network. Orders still show here."
          : null,
    });
  }
  return rows;
}

/** Everything that has to be true before the screen may move on by itself. */
export const allReady = (checks: ReadyCheck[]): boolean =>
  checks.filter((c) => c.key !== "printer").every((c) => c.ok === true);

/**
 * How long the Ready screen stays up once everything is green before it
 * shows the orders on its own. Long enough to read three ticks and a
 * button; short enough that a tablet nobody is looking at is not stuck on a
 * welcome page while an order arrives.
 */
export const READY_AUTO_ADVANCE_MS = 20_000;

/**
 * What the offline strip says on a tablet that has lost its network.
 * `since` is when the screen first went offline in this stretch; null when
 * it is not offline.
 */
export function offlineNotice(sinceLabel: string | null): string {
  return sinceLabel
    ? `Not receiving orders — Wi-Fi is down · reconnecting since ${sinceLabel}`
    : "Not receiving orders — Wi-Fi is down · reconnecting";
}

/** Where the office's own alarm comes from, said honestly: it fires if this lasts. */
export const OFFLINE_FOOTER = "If this lasts, Premium is told automatically.";
