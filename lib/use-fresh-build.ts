"use client";

import { useEffect } from "react";
import { SHELL_VERSION_KEY, readShellVersion, updateAvailable } from "./app-update";

/**
 * On the pages that are not the dashboard - login, and a ticket - take a new
 * deployment when the screen comes back to the foreground, and only then.
 *
 * The dashboard reloads itself at a quiet moment on the heartbeat's cadence
 * (see OrderDashboard). These two pages have no heartbeat and no "quiet"
 * to measure, but they do have one honest moment: the instant the tablet
 * returns from being backgrounded, nobody was mid-anything on it. `canReload`
 * is the page's own veto for the cases that are not true - a login form
 * somebody has started typing into, a ticket mid-Accept.
 *
 * Never on a timer, never on mount: a ticket somebody is reading is not
 * reloaded to get a new build. That trade is the whole point of waiting.
 */
export function useFreshBuildOnReturn(canReload: () => boolean): void {
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!updateAvailable(process.env.NEXT_PUBLIC_BUILD_ID ?? "dev", data?.buildId)) return;
        if (!canReload()) return;
        window.location.reload();
      } catch {
        // A check that cannot reach the server tells us nothing, and must
        // never be the reason a working screen does anything at all.
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [canReload]);
}

/**
 * Remember which Android shell we are inside, if this URL says.
 *
 * The TWA opens /dashboard?shell=N, and a signed-out tablet is bounced to
 * /login?next=/dashboard?shell=N before the dashboard ever mounts - so the
 * login page has to be the one that notices, or the param is lost for the
 * life of the install. Harmless anywhere else: no param, nothing written.
 */
export function rememberShellVersion(): void {
  try {
    const remembered = window.localStorage.getItem(SHELL_VERSION_KEY);
    const v = readShellVersion(window.location.href, remembered);
    if (v !== null && String(v) !== remembered) {
      window.localStorage.setItem(SHELL_VERSION_KEY, String(v));
    }
  } catch {
    // Storage unavailable. The dashboard will try again from its own URL.
  }
}
