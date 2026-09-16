"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Brand } from "@/components/Brand";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { deviceId, readRestaurantCache, rememberDeviceRef, writeRestaurantCache } from "@/lib/kiosk-cache";
import { LINK_STATUS_POLL_MS } from "@/lib/link-code";
import { BOOTSTRAP_POLL_MS } from "@/lib/device-binding";
import { KIOSK_WIFI_HINT } from "@/lib/first-run";
import { rememberShellVersion, useFreshBuildOnReturn } from "@/lib/use-fresh-build";

const SUPPORT_PHONE = "(615) 619-5081";

/**
 * The Pairing screen. A tablet with a network and no valid session lands
 * here instead of on a login form. Nobody types anything.
 *
 * Two things happen at once, and whichever answers first wins:
 *
 *   1. Bootstrap (1b). If the Android shell put a device reference on the
 *      start URL - the serial Hexnode pushed, or the install's own id -
 *      the page asks the bridge whose tablet this is, every few seconds.
 *      The office assigning it in the CRM lands here without a reboot.
 *   2. Link code (1c). The page shows six digits bound to this device;
 *      the office can link it by code instead, on the phone.
 *
 * Either way the bridge answers with a magic-link hash that is verified
 * right here in the browser - which is what sets the session cookies -
 * and the page goes to the orders. There is deliberately no link to
 * /login and no Wi-Fi control: the kiosk draws its own Wi-Fi button.
 */
type Phase =
  /** Cannot reach the bridge. Say so, keep trying. */
  | "offline"
  | "requesting"
  | "waiting"
  /** The office bound or linked it; the session is being set. */
  | "linking"
  | "failed";

function LinkScreen() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [phase, setPhase] = useState<Phase>("requesting");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState<string | null>(null);
  const [deviceRef, setDeviceRef] = useState<string | null>(null);
  const device = useRef<string | null>(null);
  const settling = useRef(false);

  useEffect(() => {
    rememberShellVersion();
    // A tablet that WAS linked and lost its session still knows whose it is.
    // Saying so tells the office which restaurant to link it back to.
    setKnown(readRestaurantCache()?.name ?? null);
    device.current = deviceId();
    setDeviceRef(rememberDeviceRef(window.location.href));
  }, []);

  useFreshBuildOnReturn(useCallback(() => phase !== "linking", [phase]));

  /**
   * Turn a magic-link hash into a session and leave. Once: bootstrap and
   * the link poll can both succeed in the same few seconds, and the
   * second hash would fail to verify against a session already set.
   */
  const settle = useCallback(
    async (tokenHash: string, restaurant: { id: string; name: string } | null) => {
      if (settling.current) return;
      settling.current = true;
      setPhase("linking");
      const supabase = supabaseBrowser();
      const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
      if (verifyError) {
        settling.current = false;
        setError("Linked, but the session could not be set: " + verifyError.message);
        setPhase("failed");
        return;
      }
      if (restaurant?.id && restaurant?.name) writeRestaurantCache(restaurant);
      // A full navigation, not a router push: the session lives in cookies
      // the server must read, and a client-side transition would arrive
      // before they are set.
      window.location.assign(next);
    },
    [next]
  );

  const requestCode = useCallback(async () => {
    setPhase("requesting");
    try {
      const res = await fetch("/api/kiosk/link-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: device.current ?? deviceId() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.code !== "string") {
        setError(data?.error ?? "The server could not issue a code (" + res.status + ").");
        setPhase("failed");
        return;
      }
      setCode(data.code);
      setError(null);
      setPhase("waiting");
    } catch {
      // No network. Retried on a timer below; the kiosk's own Wi-Fi button
      // is the fix, and the screen says so.
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    void requestCode();
  }, [requestCode]);

  // Offline or failed: keep asking, and leave the moment the network is back.
  useEffect(() => {
    if (phase !== "offline" && phase !== "failed") return;
    const id = setInterval(() => void requestCode(), LINK_STATUS_POLL_MS);
    const onOnline = () => void requestCode();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, [phase, requestCode]);

  // Bootstrap (1b): whose tablet is this? Asked while a reference is known
  // and nothing has settled yet.
  useEffect(() => {
    if (!deviceRef || phase === "linking" || phase === "offline") return;
    let stopped = false;
    const ask = async () => {
      try {
        const res = await fetch("/api/kiosk/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device: deviceRef, model: navigator.userAgent.slice(0, 120) }),
        });
        const data = await res.json().catch(() => ({}));
        // A bound answer is honoured even if this effect was torn down while
        // the request was in flight (React re-running effects in development,
        // a re-render mid-request): the bridge has already minted and
        // stamped the session, and dropping it here would mean a thirty-
        // second wait for the next one. settle() runs once whatever happens.
        if (res.ok && data?.status === "bound" && typeof data.token_hash === "string") {
          await settle(data.token_hash, data.restaurant ?? null);
          return;
        }
        if (stopped) return;
        // unbound / throttled: ask again next tick. Nothing to show.
      } catch {
        // The link-code path reports the network; this one stays quiet.
      }
    };
    const id = setInterval(ask, BOOTSTRAP_POLL_MS);
    void ask();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [deviceRef, phase, settle]);

  // Link code (1c): has the office linked it?
  useEffect(() => {
    if (phase !== "waiting" || !code) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(
          "/api/kiosk/link-status?code=" + encodeURIComponent(code) + "&device=" + encodeURIComponent(device.current ?? ""),
          { cache: "no-store" }
        );
        if (stopped) return;
        const data = res.status === 404 ? null : await res.json().catch(() => ({}));
        if (res.status === 404 || data?.status === "expired" || data?.status === "consumed") {
          // Not ours any more (a cleared device id, a wiped row), or spent:
          // start over - after one poll interval, not immediately. A server
          // that keeps answering 404 must not be asked for a new code at
          // network speed by every tablet on the fleet.
          stopped = true;
          clearInterval(id);
          setTimeout(() => void requestCode(), LINK_STATUS_POLL_MS);
          return;
        }
        if (data?.status === "linked" && typeof data.token_hash === "string") {
          await settle(data.token_hash, data.restaurant ?? null);
        }
      } catch {
        // A poll that failed says nothing; the next one runs anyway.
      }
    };
    const id = setInterval(poll, LINK_STATUS_POLL_MS);
    void poll();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [phase, code, requestCode, settle]);

  return (
    <div className="alert-gate pairing" role="main">
      <div className="alert-gate-inner pairing-inner">
        <Brand size="md" />
        {known && <p className="alert-gate-restaurant">{known}</p>}

        {phase === "offline" && (
          <>
            <h1>Not connected</h1>
            <p>This tablet can&apos;t reach Premium. {KIOSK_WIFI_HINT}</p>
            <p className="alert-gate-help">Once it&apos;s connected, this screen moves on by itself.</p>
          </>
        )}

        {(phase === "requesting" || phase === "waiting" || phase === "linking") && (
          <>
            <h1>{deviceRef ? "Waiting for Premium to assign this tablet" : "Link this tablet"}</h1>
            <p>
              {deviceRef
                ? "Premium can assign it from the office - or call "
                : "Call Premium on "}
              <strong>{SUPPORT_PHONE}</strong> and read them this code. There is nothing to type here.
            </p>
            <div className="link-code num" aria-live="polite" aria-label={code ? "Link code " + code.split("").join(" ") : "Getting a code"}>
              {code ? code.slice(0, 3) + " " + code.slice(3) : "··· ···"}
            </div>
            <p className="alert-gate-help">
              {phase === "linking"
                ? "Linked — setting up…"
                : phase === "waiting"
                  ? "Waiting for Premium. This screen changes on its own once it's done."
                  : "Getting a code…"}
            </p>
            {deviceRef && <p className="alert-gate-help pairing-ref">Tablet {deviceRef}</p>}
          </>
        )}

        {phase === "failed" && (
          <>
            <h1>Could not link this tablet</h1>
            <p className="alert-gate-error">{error}</p>
            <button className="btn primary alert-gate-action" onClick={() => void requestCode()}>
              Try again
            </button>
            <p className="alert-gate-help">
              Stuck? Call Premium on <strong>{SUPPORT_PHONE}</strong>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function LinkPage() {
  return (
    <Suspense fallback={null}>
      <LinkScreen />
    </Suspense>
  );
}
