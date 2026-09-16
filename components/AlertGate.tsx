"use client";

import { Brand } from "./Brand";
import { gateBlocks } from "@/lib/alert-gate";
import { useAlertGate } from "./useAlertGate";

/** The number on the printed login ticket, so a restaurant reads the same one everywhere. */
const SUPPORT_PHONE = "(615) 619-5081";

/**
 * The gate. Nothing below it renders while alerts are off.
 *
 * The reading, the silent repair and the one tap live in useAlertGate, which
 * the first-run Ready screen shares - one brain, two faces, so the two
 * cannot disagree about whether this tablet will ring.
 *
 * `onSubscribedChange` lets the dashboard's status pill read the same fact
 * this component just established, rather than probing for it separately and
 * disagreeing.
 */
export default function AlertGate({
  restaurantName,
  onSubscribedChange,
}: {
  restaurantName: string;
  onSubscribedChange?: (subscribed: boolean) => void;
}) {
  const { state, busy, error, check, turnOn } = useAlertGate(onSubscribedChange);

  // Nothing decided yet: show nothing rather than flashing a gate over a
  // working screen for the half-second the async read takes.
  if (state === null || !gateBlocks(state)) return null;

  return (
    <div className="alert-gate" role="dialog" aria-modal="true" aria-labelledby="alert-gate-title">
      <div className="alert-gate-inner">
        <Brand size="md" />
        <p className="alert-gate-restaurant">{restaurantName}</p>

        {state === "ask" && (
          <>
            <h1 id="alert-gate-title">Turn on order alerts</h1>
            <p>
              This tablet will not ring for a new order until alerts are on. It takes one tap, and
              it only has to be done once on this device.
            </p>
            <button className="btn primary alert-gate-action" disabled={busy} onClick={turnOn}>
              {busy ? "Turning on…" : "Turn on alerts"}
            </button>
          </>
        )}

        {state === "blocked" && (
          <>
            <h1 id="alert-gate-title">Alerts are blocked on this tablet</h1>
            <p>
              Notifications were turned off for this app, and only Android can turn them back on —
              this screen is not allowed to ask again.
            </p>
            <ol className="alert-gate-steps">
              <li>Open Android <strong>Settings</strong>.</li>
              <li>
                Go to <strong>Apps</strong> → <strong>Premium</strong> → <strong>Notifications</strong>.
              </li>
              <li>Turn notifications <strong>on</strong>.</li>
              <li>Come back here and tap <strong>Check again</strong>.</li>
            </ol>
            <button className="btn primary alert-gate-action" disabled={busy} onClick={() => void check()}>
              Check again
            </button>
            <p className="alert-gate-help">
              Stuck? Call Premium on <strong>{SUPPORT_PHONE}</strong>.
            </p>
          </>
        )}

        {state === "unsupported" && (
          <>
            <h1 id="alert-gate-title">Open this in the Premium app</h1>
            <p>
              This browser cannot receive order alerts. Orders should be watched in the Premium
              app on the tablet Premium set up for you — the alert is the whole point of the
              screen.
            </p>
            <p className="alert-gate-help">
              Call Premium on <strong>{SUPPORT_PHONE}</strong> and we&apos;ll sort the tablet out.
              There is nothing to download.
            </p>
          </>
        )}

        {error && <p className="alert-gate-error">{error}</p>}
      </div>
    </div>
  );
}
