"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Order } from "@/lib/types";
import OrderCard from "./OrderCard";
import { ageMs, elapsedLabel, isSettled, isWaiting, type DisplayMode } from "@/lib/order-display";
import { Brand } from "./Brand";
import { clockLabel } from "@/lib/clock";
import AlertGate from "./AlertGate";
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
  unaccepted,
  liveState,
  HEARTBEAT_EVERY_MS,
} from "@/lib/kiosk";

/**
 * What the lists are called.
 *
 * Was New / Opened / Completed / Printed - the database's own words. Two of
 * those are not distinctions a kitchen can act on: 'opened' only means
 * somebody tapped the row, and 'printed' is a fact about the paper channel,
 * which is independent of the tablet. orderFlag() already collapses them, so
 * the tabs now say the same three things the cards do.
 *
 * "Done" deliberately includes cancelled: nothing is owed on it either. The
 * card still shows it as cancelled, struck through, so it cannot be mistaken
 * for something that was cooked.
 */
type TabKey = "waiting" | "accepted" | "done" | "all";

const TABS: { key: TabKey; label: string }[] = [
  { key: "waiting", label: "Waiting" },
  { key: "accepted", label: "Accepted" },
  { key: "done", label: "Done" },
  { key: "all", label: "Show all" },
];

function inTab(order: Order, key: TabKey): boolean {
  if (key === "all") return true;
  if (!isSettled(order)) return key === "waiting";
  if (order.accepted_at) return key === "accepted";
  return key === "done";
}

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
  const [tab, setTab] = useState<TabKey>("waiting");
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
   * What the chime is sounding for.
   *
   * Keyed on acceptance, not on status 'new'. 'new' cleared itself the moment
   * anyone tapped the order, so a glance or a mis-tap silenced the tablet
   * without a single person having agreed to cook anything.
   */
  const waiting = useMemo(() => unaccepted(orders), [orders]);
  const hasNewOrders = waiting.length > 0;

  /**
   * What the Waiting tab holds - and therefore what the headline says.
   *
   * Not the same set as `waiting` above, on purpose. That one is the chime's,
   * and it drops anything past six hours so a tablet does not ring all day
   * about orders nobody is going to cook. This one has no cutoff: an order
   * nobody accepted is still owed a decision, and the tab shows it. The
   * headline used to count the chime's set, so a screen with ten stale
   * orders in Waiting announced "All clear" above them.
   */
  const waitingRows = useMemo(() => orders.filter(isWaiting), [orders]);
  const anyWaiting = waitingRows.length > 0;

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
        // screen that will not. null until AlertGate has answered. And which
        // shell this is, so the office can see who needs one pushed.
        body: JSON.stringify({ pushSubscribed, shellVersion }),
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
  }, [pushSubscribed, shellVersion]);

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

  const filtered = orders.filter((o) => inTab(o, tab));
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
   * The oldest thing nobody has accepted. "3 waiting" says how much; this
   * says how bad, which is the number somebody in a kitchen acts on.
   */
  const oldest = waitingRows.reduce<Order | null>((worst, o) => {
    if (!worst) return o;
    return (ageMs(o, now) ?? 0) > (ageMs(worst, now) ?? 0) ? o : worst;
  }, null);

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
      <AlertGate restaurantName={restaurantName} onSubscribedChange={setPushSubscribed} />

      {warning && (
        <div className={`kiosk-banner kiosk-${warning.level}`} role="status">
          {warning.text}
        </div>
      )}

      <div className="app-head">
        <div className="app-head-id">
          <Brand size="sm" />
          {/* The restaurant's own name, which this screen never showed. A
              tablet signed into the wrong restaurant used to look exactly
              like one signed into the right one. */}
          <span className="app-head-restaurant">{restaurantName}</span>
        </div>

        {/* The count IS the headline. Everything else on this screen is
            detail about it, and on a kitchen tablet the only question being
            asked from across the room is "is anything waiting". */}
        <span className={`app-head-count num ${anyWaiting ? "busy" : "idle"}`}>
          {anyWaiting ? `${waitingRows.length} WAITING` : "All clear"}
          {anyWaiting && oldest && (
            <span className="app-head-oldest num">oldest {elapsedLabel(oldest, now)}</span>
          )}
        </span>

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

      {/* Why the room is beeping, in one line, and what stops it. When
          nothing is beeping but the list is not empty - everything in it is
          past the chime window - say that instead, because "press Accept"
          is still the only thing that clears them. */}
      {anyWaiting && (
        <div className="waiting-bar" role="status">
          {waitingRows.length === 1
            ? `1 order ${hasNewOrders ? "waiting" : "from earlier still waiting"} — open it and press Accept`
            : `${waitingRows.length} orders ${hasNewOrders ? "waiting" : "from earlier still waiting"} — open each one and press Accept`}
        </div>
      )}

      <div className="app-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`app-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key !== "all" && ` (${orders.filter((o) => inTab(o, t.key)).length})`}
          </button>
        ))}
      </div>

      <div className="app-list">
        {filtered.length === 0 && (
          <div className="app-empty">
            {tab === "waiting"
              ? "Nothing waiting. All caught up."
              : tab === "all"
                ? `No orders for ${restaurantName} yet today.`
                : "Nothing in this list."}
          </div>
        )}
        {filtered.map((order) => (
          <OrderCard key={order.id} order={order} now={now} />
        ))}
      </div>
    </div>
  );
}
