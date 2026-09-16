"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Order } from "@/lib/types";
import OrderCard from "./OrderCard";
import CompletedRow from "./CompletedRow";
import PastWeek from "./PastWeek";
import { bucketOf, elapsedLabel, isLate, type DisplayMode } from "@/lib/order-display";
import { countsForHistory, money } from "@/lib/history";
import { Brand } from "./Brand";
import { clockLabel } from "@/lib/clock";
import AlertGate from "./AlertGate";
import type { AlertGateState } from "@/lib/alert-gate";
import ReadyScreen from "./ReadyScreen";
import { KIOSK_WIFI_HINT, OFFLINE_FOOTER, offlineNotice } from "@/lib/first-run";
import { isSetupDone, markSetupDone, rememberDeviceRef, writeRestaurantCache } from "@/lib/kiosk-cache";
import {
  SHELL_VERSION_KEY,
  readShellVersion,
  shellNeedsUpdate,
  shouldReloadNow,
  updateAvailable,
} from "@/lib/app-update";
import { armAudio, isAudioArmed, playAlertBeep } from "@/lib/sound";
import {
  Connection,
  isStale,
  kioskWarning,
  pollDelayMs,
  reloadHoldMs,
  realtimeConnection,
  unseen,
  liveState,
  HEARTBEAT_EVERY_MS,
} from "@/lib/kiosk";

/**
 * What the lists are called.
 *
 * Two lists and a history (Nick, 2026-09-16). "Orders" is everything in
 * the kitchen today; "Completed" is what was finished today; "Past week"
 * is read-only. Was Waiting / Accepted / Done - three states of a step
 * that no longer exists. There is no Accept: opening a ticket is the
 * acknowledgement, Done is the one action, and an order nobody marked done
 * ages off the list six hours after it arrived.
 */
type TabKey = "orders" | "completed" | "past";

export default function OrderDashboard({
  initialOrders,
  restaurantId,
  mode,
  restaurantName,
  timezone,
}: {
  initialOrders: Order[];
  restaurantId: string;
  /** kitchen or standard, from the restaurant's own setting. */
  mode: DisplayMode;
  restaurantName: string;
  /**
   * IANA zone for the header clock, from restaurants.timezone (migration
   * 032). Null means nobody has told us, and the clock shows device time -
   * the CRM pushes the account's real zone, because tablets are provisioned
   * in Nashville and a screen in eastern Kentucky would otherwise read an
   * hour slow all day.
   */
  timezone: string | null;
}) {
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [tab, setTab] = useState<TabKey>("orders");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [soundArmed, setSoundArmed] = useState(true); // assume ok until checked
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  /**
   * When the office last heard from this screen, and whether this browser has
   * a push subscription. Both feed the status pill. null means NOT YET KNOWN,
   * which is not the same as missing - see liveState().
   */
  const [heartbeatOkAt, setHeartbeatOkAt] = useState<number | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  /**
   * Which gate state the alert hook landed on, for the heartbeat. "blocked"
   * on a managed kiosk means the Hexnode notification policy is missing or
   * changed - nothing at the store can fix that, so the office has to see
   * it (migration 037). null until the hook has read anything.
   */
  const [alertState, setAlertState] = useState<AlertGateState | null>(null);
  const onAlertStateChange = useCallback((subscribed: boolean, state: AlertGateState) => {
    setPushSubscribed(subscribed);
    setAlertState(state);
  }, []);

  /**
   * First run on this device (Workstream I). null until read - localStorage
   * is not available during the server render, and a Ready screen that
   * flashes over a working tablet on every load would be worse than none.
   * The restaurant is remembered at the same time, so the offline page and
   * the Pairing screen can name it without a network.
   */
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => {
    writeRestaurantCache({ id: restaurantId, name: restaurantName });
    setFirstRun(!isSetupDone());
    // The shell's ?device= reference, kept so a lost session still knows
    // which tablet this is (lib/device-binding.ts).
    rememberDeviceRef(window.location.href);
  }, [restaurantId, restaurantName]);
  const finishSetup = useCallback(() => {
    markSetupDone();
    setFirstRun(false);
  }, []);

  /**
   * Which Android shell this page runs inside, from the TWA's ?shell= param
   * (remembered, because the login redirect drops it), and the oldest shell
   * the office is happy with, from the heartbeat. Neither asks the
   * restaurant for anything: the MDM pushes shells.
   */
  const [shellVersion, setShellVersion] = useState<number | null>(null);
  const [minShell, setMinShell] = useState<number>(0);
  useEffect(() => {
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(SHELL_VERSION_KEY);
    } catch {}
    const v = readShellVersion(window.location.href, remembered);
    setShellVersion(v);
    if (v !== null && String(v) !== remembered) {
      try {
        window.localStorage.setItem(SHELL_VERSION_KEY, String(v));
      } catch {}
    }
  }, []);
  const [now, setNow] = useState(() => Date.now());
  const soundIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * What the chime is sounding for: orders nobody here has opened. Keyed
   * on opening, not on acceptance - there is no Accept step any more - and
   * still bounded to the six-hour window so a tablet does not ring all day
   * about a backlog nobody is going to cook.
   */
  const waiting = useMemo(() => unseen(orders), [orders]);
  const hasNewOrders = waiting.length > 0;

  /**
   * Reconcile against the database directly.
   *
   * Runs on a timer whether or not the socket is healthy, because realtime is
   * an optimisation here and not the guarantee. A websocket that has been open
   * for three weeks on a kitchen wall and quietly died is the failure this
   * survives - and a missed order costs far more than a query a minute.
   */
  const sync = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .order("received_at", { ascending: false })
      .limit(200);
    if (error || !data) return;
    setOrders(data as Order[]);
    setLastSyncAt(Date.now());
  }, [restaurantId]);

  // --- Realtime, with its status actually observed ---------------------------
  // .subscribe() used to be called with no callback at all, so a dropped
  // channel was invisible: the list simply stopped updating and the screen
  // kept saying what it said an hour ago.
  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`orders-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        (payload) => {
          setLastSyncAt(Date.now());
          setOrders((prev) => {
            if (payload.eventType === "INSERT") {
              const newOrder = payload.new as Order;
              if (prev.some((o) => o.id === newOrder.id)) return prev;
              return [newOrder, ...prev];
            }
            if (payload.eventType === "UPDATE") {
              const updated = payload.new as Order;
              return prev.map((o) => (o.id === updated.id ? updated : o));
            }
            return prev;
          });
        }
      )
      .subscribe((status) => {
        const next = realtimeConnection(status);
        setConnection(next);
        // Coming back from a drop, the list is by definition behind - whatever
        // arrived while the socket was down was never delivered to this tab.
        if (next === "live") void sync();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [restaurantId, sync]);

  // --- Poll, always, faster when the socket is known to be down -------------
  // A timeout chain rather than an interval, so each wait is jittered on
  // its own: five hundred tablets on a fixed 60 s interval all poll in the
  // same second forever (see pollDelayMs).
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      id = setTimeout(() => {
        void sync();
        tick();
      }, pollDelayMs(connection));
    };
    tick();
    return () => clearTimeout(id);
  }, [connection, sync]);

  // Drives the staleness check AND the age timers on every card.
  //
  // Every second, not the 10 it used to be: the cards count up in m:ss, and a
  // clock that jumps ten seconds at a time reads as broken rather than live.
  // It is one setState of a number - the work is the re-render, and this
  // screen is a list of at most a couple of hundred rows.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // --- Sound has to be armed by a real gesture ------------------------------
  // Any touch anywhere counts, so the first person to walk past and prod the
  // screen fixes it - which is the only thing that will happen on a tablet
  // that rebooted overnight with nobody watching.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await armAudio();
      if (!cancelled) setSoundArmed(ok);
    };
    void check();

    const onGesture = () => void check();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    // Android suspends the context when the kiosk is backgrounded; coming back
    // to the foreground needs it resumed or the next order arrives in silence.
    document.addEventListener("visibilitychange", onGesture);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onGesture);
    };
  }, []);

  // --- Say that a signed-in screen is actually open --------------------------
  //
  // A push subscription belongs to the browser's service worker, not to the
  // session, so it outlives being signed out: a tablet sitting on a login
  // screen kept reporting delivered pushes while nobody saw a single order.
  // This is the one signal that tells a watched screen from a dead one.
  //
  // Fire-and-forget. A heartbeat that failed to record must never disturb the
  // thing it is reporting on.
  useEffect(() => {
    const beat = () => {
      // Still fire-and-forget for the REQUEST, but the outcome is recorded:
      // the pill claimed the office could see this tablet with nothing behind
      // the claim, and "the office cannot see you" is a thing a restaurant can
      // act on.
      void fetch("/api/dashboard/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // So the office can tell an open screen that will ring from an open
        // screen that will not, and WHY not (alertState) - null until
        // AlertGate has answered. And which shell this is, so the office
        // can see who needs one pushed.
        body: JSON.stringify({ pushSubscribed, shellVersion, alertState }),
      })
        .then(async (res) => {
          // 429 is the server saying "you beat less than a minute ago and I
          // still have it" - which is exactly a live heartbeat, not a failed one.
          if (res.ok || res.status === 429) setHeartbeatOkAt(Date.now());
          // The beat answers with what deployment is serving. This is the
          // version check: one request on a cadence that already exists,
          // rather than a second one on the same cadence.
          const data = await res.json().catch(() => null);
          if (updateAvailable(process.env.NEXT_PUBLIC_BUILD_ID ?? "dev", data?.buildId)) {
            if (reloadNotBeforeRef.current === null) reloadNotBeforeRef.current = Date.now() + reloadHoldMs();
            setNewBuild(true);
          }
          if (typeof data?.minShellVersion === "number") setMinShell(data.minShellVersion);
        })
        .catch(() => {
          // A beat that cannot reach the server tells us nothing, and must
          // never be the reason a working screen does anything at all.
        });
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_EVERY_MS);
    // Coming back to the foreground, say so immediately rather than waiting
    // out the interval - a tablet that was backgrounded is exactly when the
    // monitor is closest to deciding nobody is there.
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Re-run when the subscription answer changes: with [] this closure would
    // capture the first value (null, before AlertGate has looked) and report
    // it for the life of the tab.
  }, [pushSubscribed, shellVersion, alertState]);

  // The push subscription is read and repaired by AlertGate, which owns that
  // question - it reports the answer here through onSubscribedChange so the
  // status pill and the gate cannot disagree about whether this tablet will
  // ring. Two separate probes is how they start to.

  // --- Take new code without anybody relaunching the app --------------------
  //
  // A TWA loads the live site, so a deploy reaches the tablet immediately -
  // except that this page has been open for weeks and is still running the
  // JavaScript it downloaded then. Nothing reloads a kiosk.
  //
  // It waits for a quiet moment. A reload destroys the AudioContext and
  // browsers only let one be resumed from a gesture, so reloading while an
  // order is waiting would silence the chime on a screen somebody needs right
  // now. Nothing waiting means nothing to interrupt. The push notification -
  // the real alarm - is an Android notification and survives either way.
  const [newBuild, setNewBuild] = useState(false);
  // When this tablet is allowed to take the new build, at the earliest:
  // spread over ten minutes from first hearing of it, so a deploy does not
  // reload every idle tablet in the same heartbeat window.
  const reloadNotBeforeRef = useRef<number | null>(null);

  // When the glass was last touched. "Nothing waiting" says nobody needs the
  // screen; this says nobody is using it. Starts at mount so a fresh page is
  // "untouched since it opened", which is true.
  const lastTouchRef = useRef<number>(Date.now());
  useEffect(() => {
    const touched = () => {
      lastTouchRef.current = Date.now();
    };
    window.addEventListener("pointerdown", touched, { passive: true });
    window.addEventListener("keydown", touched, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", touched);
      window.removeEventListener("keydown", touched);
    };
  }, []);

  // Re-evaluated on every heartbeat (heartbeatOkAt changes each beat), so a
  // reload that was not safe this time is simply tried again next time -
  // the busy restaurant updates at its next quiet moment, not never.
  useEffect(() => {
    if (
      !shouldReloadNow({
        updateAvailable: newBuild,
        waitingCount: waiting.length,
        visible: typeof document !== "undefined" && document.visibilityState === "visible",
        idleMs: Date.now() - lastTouchRef.current,
      })
    ) {
      return;
    }
    // Quiet, but not yet this tablet's turn: the spread is re-checked on the
    // next beat like every other gate.
    if (reloadNotBeforeRef.current !== null && Date.now() < reloadNotBeforeRef.current) return;
    // A short delay so this cannot fire in the same tick as an order being
    // accepted - the list settles first, and a reload that races a write is
    // the one way this could lose something.
    const id = setTimeout(() => window.location.reload(), 3_000);
    return () => clearTimeout(id);
  }, [newBuild, waiting.length, heartbeatOkAt]);

  // --- Keep the screen on ---------------------------------------------------
  // A kiosk whose screen has gone to sleep is a kiosk nobody can see an order
  // on. The lock is dropped whenever the page is hidden, so it is re-taken on
  // every return to the foreground.
  useEffect(() => {
    let lock: any = null;
    const request = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        lock = await (navigator as any).wakeLock?.request("screen");
      } catch {
        // Unsupported, or refused on battery. The kiosk launcher's own
        // keep-awake setting is the real guarantee; this is belt and braces.
      }
    };
    void request();
    document.addEventListener("visibilitychange", request);
    return () => {
      document.removeEventListener("visibilitychange", request);
      try {
        lock?.release();
      } catch {
        /* already gone */
      }
    };
  }, []);

  // --- Chime while anything is unopened -------------------------------------
  useEffect(() => {
    if (hasNewOrders && soundArmed) {
      if (!soundIntervalRef.current) {
        playAlertBeep();
        soundIntervalRef.current = setInterval(playAlertBeep, 8000);
      }
    } else if (soundIntervalRef.current) {
      clearInterval(soundIntervalRef.current);
      soundIntervalRef.current = null;
    }
    return () => {
      if (soundIntervalRef.current) {
        clearInterval(soundIntervalRef.current);
        soundIntervalRef.current = null;
      }
    };
  }, [hasNewOrders, soundArmed]);

  const stale = isStale(lastSyncAt, now);
  const warning = kioskWarning({ connection, soundArmed, stale });
  const live = liveState({
    connection,
    stale,
    soundArmed,
    pushSubscribed,
    heartbeatOkAt,
    now,
  });

  /**
   * The two lists, from one rule (bucketOf) so the tab counts, the hero
   * line and the rows cannot disagree. Orders oldest first - the top of the
   * list is the ticket that has waited longest, which is the one the
   * kitchen picks up next. Completed newest first - the last thing you did
   * is the one you want to check.
   *
   * `now` moves every second and the six-hour window is read from it,
   * which is how an order ages off the list without a reload.
   */
  const kitchen = useMemo(
    () =>
      orders
        .filter((o) => bucketOf(o, now, timezone) === "orders")
        .sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0)),
    [orders, now, timezone]
  );
  const completed = useMemo(
    () =>
      orders
        .filter((o) => bucketOf(o, now, timezone) === "completed")
        .sort((a, b) => {
          const ta = a.completed_at ?? a.cancelled_at ?? a.received_at;
          const tb = b.completed_at ?? b.cancelled_at ?? b.received_at;
          return ta < tb ? 1 : ta > tb ? -1 : 0;
        }),
    [orders, now, timezone]
  );
  const completedCounted = completed.filter(countsForHistory);
  const completedTotal = completedCounted.reduce((sum, o) => sum + (o.customer_total ?? 0), 0);

  /**
   * The oldest thing in the kitchen. "3 orders" says how much; this says
   * how bad, which is the number somebody in a kitchen acts on. Red the
   * moment any of them is late.
   */
  const oldest = kitchen[0] ?? null;
  const anyLate = kitchen.some((o) => isLate(o, now));

  /**
   * When this stretch of being offline began, for the strip's "reconnecting
   * since 6:39 PM". Set on the way into offline, cleared on the way out; a
   * clock that restarted on every render would say "since just now" forever.
   */
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  useEffect(() => {
    if (live.level === "offline") setOfflineSince((s) => s ?? Date.now());
    else setOfflineSince(null);
  }, [live.level]);
  const offline = live.level === "offline";

  // The tab a restaurant sees on the wall all day. Naming the restaurant
  // means a tablet showing the wrong one is obvious at a glance rather than
  // after somebody wonders why the orders look unfamiliar.
  useEffect(() => {
    document.title = `${restaurantName} — Premium Orders`;
  }, [restaurantName]);

  return (
    <div className="app" data-display={mode}>
      {/* Above everything. Nothing below this renders while alerts are off -
          a tablet that cannot ring is not a tablet, it is a screen. */}
      {/* First run on this device: the Ready screen carries the same gate as
          one of its three checks, and the one tap happens there. Every run
          after that: the gate on its own, only if alerts are ever off. */}
      {firstRun === true ? (
        <ReadyScreen
          restaurantName={restaurantName}
          online={connection !== "down" && !stale}
          onSubscribedChange={onAlertStateChange}
          onDone={finishSetup}
        />
      ) : firstRun === false ? (
        <AlertGate restaurantName={restaurantName} onSubscribedChange={onAlertStateChange} />
      ) : null}

      {/* Offline has its own strip below, with the button that fixes it; the
          generic banner keeps only the sound case, which outranks it. */}
      {warning && (!offline || !soundArmed) && (
        <div className={`kiosk-banner kiosk-${warning.level}`} role="status">
          {warning.text}
        </div>
      )}

      {offline && (
        <div className="offline-strip" role="alert">
          <span className="offline-text">{offlineNotice(offlineSince ? clockLabel(offlineSince, timezone) : null)}</span>
          {/* The kiosk's control, not ours. Hexnode draws the Wi-Fi button;
              this app never does. */}
          <span className="offline-hint">{KIOSK_WIFI_HINT}</span>
        </div>
      )}

      <div className="app-head">
        <div className="app-head-id">
          <Brand size="sm" />
          {/* The restaurant's own name, large. A tablet signed into the
              wrong restaurant is obvious at a glance rather than after
              somebody wonders why the orders look unfamiliar. */}
          <span className="app-head-restaurant">{restaurantName}</span>
        </div>

        <div className="app-head-right">
          {/* Says the worst true thing, not the one that happens to be
              working. See liveState(). */}
          <span className={`app-live ${live.level}`} title={live.detail ?? undefined}>
            {live.label}
          </span>
          <span className="app-clock num">{clockLabel(now, timezone)}</span>
        </div>
      </div>

      {/* What is wrong and what to do about it, under the name where it is
          read. The pill is one word; this is the sentence. */}
      {live.detail && live.level !== "offline" && (
        <p className="app-head-detail" role="status">
          {live.detail}
        </p>
      )}

      {/* The one thing the web app cannot fix by reloading: the Android shell
          around it. Amber, not blocking, and it asks for nothing - the office
          sees the same fact on the heartbeat and the MDM pushes the update. */}
      {shellNeedsUpdate(shellVersion, minShell) && (
        <p className="app-head-detail shell-old" role="status">
          This tablet needs an update from Premium — we&apos;ll handle it.
        </p>
      )}

      <div className="app-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "orders"} className={`app-tab ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>
          Orders <span className="app-tab-n num">{kitchen.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "completed"} className={`app-tab ${tab === "completed" ? "active" : ""}`} onClick={() => setTab("completed")}>
          Completed <span className="app-tab-n num">{completedCounted.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "past"} className={`app-tab ${tab === "past" ? "active" : ""}`} onClick={() => setTab("past")}>
          Past week
        </button>
      </div>

      {tab === "orders" && (
        <>
          {/* The hero. The count IS the headline; the age beside it is how
              bad. Red the moment anything is late, so a glance from across
              the room is enough. */}
          <div className={`app-hero ${anyLate ? "late" : kitchen.length ? "busy" : "idle"}`} role="status">
            {kitchen.length ? (
              <>
                <b className="num">{kitchen.length}</b> {kitchen.length === 1 ? "order" : "orders"} in the kitchen
                {oldest && (
                  <>
                    {" "}· oldest <span className="num">{elapsedLabel(oldest, now)}</span>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="app-hero-check" aria-hidden="true">✓</span> All clear
              </>
            )}
          </div>

          <div className={`app-list${offline ? " offline" : ""}`}>
            {kitchen.length === 0 && (
              <div className="app-empty">Nothing in the kitchen. New orders show here and ring until they&apos;re opened.</div>
            )}
            {kitchen.map((order) => (
              <OrderCard key={order.id} order={order} now={now} />
            ))}
          </div>
        </>
      )}

      {tab === "completed" && (
        <>
          <div className="app-hero done" role="status">
            <b className="num">{completedCounted.length}</b> completed today
            {completedCounted.length > 0 && (
              <>
                {" "}· <span className="num">{money(completedTotal)}</span>
              </>
            )}
          </div>
          <div className={`app-list completed${offline ? " offline" : ""}`}>
            {completed.length === 0 && <div className="app-empty">Nothing completed yet today.</div>}
            {completed.map((order) => (
              <CompletedRow key={order.id} order={order} timezone={timezone} />
            ))}
          </div>
        </>
      )}

      {tab === "past" && <PastWeek timezone={timezone} />}

      {/* The orders above stay so the kitchen can finish them; this says who
          else already knows. True because the health check raises
          tablet_not_watching once the heartbeat has been silent long enough
          while orders arrive - "if this lasts", not "right now". */}
      {offline && <p className="offline-foot">{OFFLINE_FOOTER}</p>}
    </div>
  );
}
