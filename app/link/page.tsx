"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Brand } from "@/components/Brand";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { deviceId, isSetupDone, readRestaurantCache, writeRestaurantCache } from "@/lib/kiosk-cache";
import { LINK_STATUS_POLL_MS } from "@/lib/link-code";
import { rememberShellVersion, useFreshBuildOnReturn } from "@/lib/use-fresh-build";
import { WIFI_BUTTON_LABEL, wifiPanelUrl } from "@/lib/wifi";

const SUPPORT_PHONE = "(615) 619-5081";

/**
 * The Pairing screen. A tablet with a network and no valid session lands
 * here instead of on a login form.
 *
 * Nobody types anything. The page asks the bridge for a six-digit code
 * bound to this device, shows it, and polls until somebody in the office
 * has linked it to a restaurant. Then it collects the magic-link hash the
 * office minted, verifies it right here in the browser - which is what
 * sets the session cookies - and goes to the orders.
 *
 * There is deliberately no link to /login. That page is for Premium staff,
 * who know its address; a restaurant is never shown a username field
 * again. Nick, 2026-09-16.
 */
type Phase =
  /** Cannot reach the bridge. Say so, offer the Wi-Fi picker, keep trying. */
  | "offline"
  | "requesting"
  | "waiting"
  /** The office linked it; the session is being set. */
  | "linking"
  | "failed";

function LinkScreen() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [phase, setPhase] = useState<Phase>("requesting");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [known, setKnown] = useState<string | null>(null);
  const device = useRef<string | null>(null);

  useEffect(() => {
    rememberShellVersion();
    setOrigin(window.location.origin);
    // A tablet that WAS linked and lost its session still knows whose it is.
    // Saying so tells the office which restaurant to link it back to.
    setKnown(readRestaurantCache()?.name ?? null);
    device.current = deviceId();
  }, []);

  useFreshBuildOnReturn(useCallback(() => phase !== "linking", [phase]));

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
        setError(data?.error ?? `The server could not issue a code (${res.status}).`);
        setPhase("failed");
        return;
      }
      setCode(data.code);
      setError(null);
      setPhase("waiting");
    } catch {
      // No network: the Wi-Fi screen. Retried on a timer below.
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    void requestCode();
  }, [requestCode]);

  // Offline: keep asking, and leave the moment the network is back.
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

  // Waiting: poll for the office.
  useEffect(() => {
    if (phase !== "waiting" || !code) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/kiosk/link-status?code=${encodeURIComponent(code)}&device=${encodeURIComponent(device.current ?? "")}`,
          { cache: "no-store" }
        );
        if (stopped) return;
        if (res.status === 404) {
          // Not ours any more (a cleared device id, a wiped row): start over.
          void requestCode();
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data?.status === "expired" || data?.status === "consumed") {
          void requestCode();
          return;
        }
        if (data?.status === "linked" && typeof data.token_hash === "string") {
          setPhase("linking");
          const supabase = supabaseBrowser();
          const { error: verifyError } = await supabase.auth.verifyOtp({
            token_hash: data.token_hash,
            type: "magiclink",
          });
          if (verifyError) {
            setError(`Linked, but the session could not be set: ${verifyError.message}`);
            setPhase("failed");
            return;
          }
          if (data.restaurant?.id && data.restaurant?.name) writeRestaurantCache(data.restaurant);
          // A full navigation, not a router push: the session lives in
          // cookies the server must read, and a client-side transition
          // would arrive before they are set.
          window.location.assign(next);
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
  }, [phase, code, next, requestCode]);

  const firstRun = typeof window !== "undefined" && !isSetupDone();

  return (
    <div className="alert-gate pairing" role="main">
      <div className="alert-gate-inner pairing-inner">
        <Brand size="md" />
        {known && <p className="alert-gate-restaurant">{known}</p>}

        {phase === "offline" && (
          <>
            <h1>{firstRun ? "Connect this tablet to your Wi-Fi" : "Wi-Fi is down"}</h1>
            <p>{firstRun ? "That's the only thing to set up." : "This tablet can't reach Premium until it's back on your network."}</p>
            <a className="btn primary alert-gate-action" href={wifiPanelUrl(origin)}>
              {WIFI_BUTTON_LABEL}
            </a>
            <p className="alert-gate-help">Once it&apos;s connected, this screen moves on by itself.</p>
          </>
        )}

        {(phase === "requesting" || phase === "waiting" || phase === "linking") && (
          <>
            <h1>Link this tablet</h1>
            <p>
              Call Premium on <strong>{SUPPORT_PHONE}</strong> and read them this code. They&apos;ll connect it
              to your restaurant — there is nothing to type here.
            </p>
            <div className="link-code num" aria-live="polite" aria-label={code ? `Link code ${code.split("").join(" ")}` : "Getting a code"}>
              {code ? `${code.slice(0, 3)} ${code.slice(3)}` : "··· ···"}
            </div>
            <p className="alert-gate-help">
              {phase === "linking"
                ? "Linked — setting up…"
                : phase === "waiting"
                  ? "Waiting for Premium. This screen changes on its own once it's done."
                  : "Getting a code…"}
            </p>
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
