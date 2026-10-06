"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Order } from "@/lib/types";
import { MENU_CHANGE_EXAMPLES, QUICK_PICKS, driverLateOrder, newReplies, type RestaurantMessage } from "@/lib/messages";
import { timeLabel } from "@/lib/local-day";
import { playChime } from "@/lib/sound";

/**
 * "Message dispatch" (Matt, 2026-10-06): the kitchen writes to Premium
 * dispatch from the tablet, and dispatch's reply comes back here.
 *
 * A header button with an unread badge, and a panel with the thread, three
 * quick picks ("Where's my driver?", "Problem with an order", "Update menu")
 * and a box to type in. The thread is polled every POLL_MS whether or not the panel is
 * open, so a reply can ring and badge on a screen nobody is touching. A
 * reply chimes once (only if sound is armed - the chime is a courtesy, the
 * order alarm is the thing that must ring) and shows a banner until the
 * panel is opened.
 */
const POLL_MS = 20_000;

export default function DispatchMessages({
  orders,
  timezone,
  soundArmed,
}: {
  orders: Order[];
  timezone: string | null;
  soundArmed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<RestaurantMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [banner, setBanner] = useState(false);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [menuMode, setMenuMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const listRef = useRef<HTMLDivElement | null>(null);

  const markRead = useCallback(async () => {
    setUnread(0);
    setBanner(false);
    try {
      await fetch("/api/dashboard/messages/read", { method: "POST" });
    } catch {
      /* the badge comes back on the next poll if this did not land */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/messages", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const list: RestaurantMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      const fresh = newReplies(list, seenRef.current);
      seenRef.current = new Set(list.map((m) => m.id));
      setMessages(list);
      if (openRef.current) {
        if (fresh.length || data.unread) void markRead();
      } else {
        setUnread(Number(data?.unread) || 0);
        if (fresh.length) setBanner(true);
      }
      if (fresh.length && soundArmed) playChime();
    } catch {
      /* offline: the order list's own strip already says so */
    }
  }, [markRead, soundArmed]);

  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = async () => {
      await load();
      if (!cancelled) id = setTimeout(tick, POLL_MS + Math.random() * 4_000);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [load]);

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [open, messages.length]);

  const openPanel = () => {
    setOpen(true);
    setError(null);
    if (unread || banner) void markRead();
  };

  const send = async (payload: { kind: string; body?: string; order_id?: string | null }) => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Didn't send. Try again.");
        return false;
      }
      setMessages((m) => [...m, data.message]);
      seenRef.current?.add(data.message.id);
      return true;
    } catch {
      setError("No connection. Didn't send.");
      return false;
    } finally {
      setSending(false);
    }
  };

  const driverLate = async () => {
    const o = driverLateOrder(orders);
    await send({ kind: "driver_late", body: draft.trim() || undefined, order_id: o?.id ?? null });
    setDraft("");
  };

  const orderProblem = async (o: Order) => {
    if (await send({ kind: "order_problem", body: draft.trim() || undefined, order_id: o.id })) {
      setDraft("");
      setPicking(false);
    }
  };

  const sendText = async () => {
    if (!draft.trim()) return;
    if (await send({ kind: menuMode ? "menu_change" : "text", body: draft })) {
      setDraft("");
      setMenuMode(false);
    }
  };

  const orderNo = (id: string | null) => (id ? orders.find((o) => o.id === id)?.order_number : undefined);
  const pickable = [...orders].sort((a, b) => (a.received_at < b.received_at ? 1 : -1)).slice(0, 12);

  return (
    <>
      <button type="button" className={`msg-btn${unread ? " has-unread" : ""}`} onClick={openPanel} aria-label={unread ? `Message dispatch, ${unread} new` : "Message dispatch"}>
        Message dispatch
        {unread > 0 && <span className="msg-badge num">{unread}</span>}
      </button>

      {banner && !open && (
        <button type="button" className="msg-banner" onClick={openPanel} role="status">
          Dispatch replied. Tap to read.
        </button>
      )}

      {open && (
        <div className="msg-overlay" onClick={() => setOpen(false)}>
          <aside className="msg-panel" onClick={(e) => e.stopPropagation()} aria-label="Messages with dispatch">
            <header className="msg-head">
              <div>
                <div className="msg-title">Dispatch</div>
                <div className="msg-sub">Premium dispatch sees this right away</div>
              </div>
              <button type="button" className="msg-close" onClick={() => setOpen(false)}>
                Close
              </button>
            </header>

            <div className="msg-list" ref={listRef}>
              {messages.length === 0 && <p className="msg-empty">No messages yet. Use a quick pick or type below.</p>}
              {messages.map((m) => {
                const mine = m.direction === "from_restaurant";
                const no = orderNo(m.order_id);
                return (
                  <div key={m.id} className={`msg-row ${mine ? "mine" : "theirs"}`}>
                    <div className="msg-bubble">
                      {m.kind !== "text" && <div className="msg-kind">{QUICK_PICKS[m.kind].label}{no ? ` · #${no}` : ""}</div>}
                      <div className="msg-body">{m.body}</div>
                    </div>
                    <div className="msg-meta">
                      {mine ? "You" : m.author || "Dispatch"} · {timeLabel(m.created_at, timezone)}
                      {!mine && m.crm_ticket_no ? ` · ticket #${m.crm_ticket_no}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>

            {menuMode ? (
              <div className="msg-menu">
                <div className="msg-pick-head">
                  <span>What changed on the menu?</span>
                  <button type="button" className="msg-link" onClick={() => setMenuMode(false)}>
                    Cancel
                  </button>
                </div>
                <p className="msg-menu-hint">
                  One change per line, in your own words. Premium checks it and updates Zuppler, DoorDash and the rest for you.
                </p>
                <ul className="msg-menu-examples">
                  {MENU_CHANGE_EXAMPLES.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : picking ? (
              <div className="msg-pick">
                <div className="msg-pick-head">
                  <span>Which order?</span>
                  <button type="button" className="msg-link" onClick={() => setPicking(false)}>
                    Cancel
                  </button>
                </div>
                {pickable.length === 0 && <p className="msg-empty">No orders today.</p>}
                {pickable.map((o) => (
                  <button key={o.id} type="button" className="msg-pick-row" disabled={sending} onClick={() => orderProblem(o)}>
                    <span className="num">#{o.order_number}</span>
                    <span>{o.customer_name || "Customer"}</span>
                    <span className="msg-pick-time">{timeLabel(o.received_at, timezone)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="msg-quick">
                <button type="button" className="msg-chip" disabled={sending} onClick={driverLate}>
                  {QUICK_PICKS.driver_late.label}
                </button>
                <button type="button" className="msg-chip" disabled={sending} onClick={() => setPicking(true)}>
                  {QUICK_PICKS.order_problem.label}
                </button>
                <button type="button" className="msg-chip" disabled={sending} onClick={() => setMenuMode(true)}>
                  {QUICK_PICKS.menu_change.label}
                </button>
              </div>
            )}

            {error && <p className="msg-error" role="alert">{error}</p>}

            <form
              className="msg-compose"
              onSubmit={(e) => {
                e.preventDefault();
                void sendText();
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={menuMode ? "e.g. Ribs are now $24.99" : "Type a message to dispatch…"}
                rows={menuMode ? 4 : 2}
                maxLength={1000}
              />
              <button type="submit" className="btn msg-send" disabled={sending || !draft.trim()}>
                {sending ? "Sending…" : menuMode ? "Send menu change" : "Send"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
