/**
 * The first run of a tablet at a store, and the screens around it.
 *
 * Nick, 2026-09-16: the restaurant's only setup step is Wi-Fi. No login, no
 * pairing, no toggles. Premium signs the tablet in at the office before it
 * ships; the store joins it to their network; the app does the rest. So
 * there are exactly four things a tablet can be showing before the order
 * list, and the decision between them is pure:
 *
 *   wifi     - no connectivity, and this device has never finished setup
 *   pairing  - connectivity, but no valid session (never bound, or lost)
 *   ready    - connectivity and a session, first time on this device
 *   orders   - everything after that
 *
 * The Wi-Fi screen is a static page the service worker serves when the
 * network is down (public/offline.html) - the app itself cannot load
 * without a network, so the decision for that case is made in the worker
 * and this function is what the worker's rule mirrors. The other three are
 * React.
 */

export type FirstRunScreen = "wifi" | "pairing" | "ready" | "orders";

export function firstRunScreen(args: {
  online: boolean;
  sessionValid: boolean;
  setupDone: boolean;
}): FirstRunScreen {
  if (!args.online && !args.setupDone) return "wifi";
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
  key: "wifi" | "alerts" | "printer";
  label: string;
  /** true = tick, false = needs doing, null = not known yet */
  ok: boolean | null;
  /** What to do when it is false, in the restaurant's words. */
  action: string | null;
}

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
      key: "wifi",
      label: "Wi-Fi connected",
      ok: args.online,
      action: args.online ? null : "Choose a Wi-Fi network to connect this tablet.",
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
 * What the offline strip says on a tablet that has finished setup and lost
 * its network. `since` is when the screen first went offline in this
 * stretch; null when it is not offline.
 */
export function offlineNotice(sinceLabel: string | null): string {
  return sinceLabel
    ? `Not receiving orders — Wi-Fi is down · reconnecting since ${sinceLabel}`
    : "Not receiving orders — Wi-Fi is down · reconnecting";
}

/** Where the office's own alarm comes from, said honestly: it fires if this lasts. */
export const OFFLINE_FOOTER = "If this lasts, Premium is told automatically.";
