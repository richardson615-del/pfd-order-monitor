"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MENU_CHANGE_EXAMPLES } from "@/lib/messages";
import { filterMenu, money, parsePriceInput, type MenuEdit, type TabletMenu, type TabletMenuItem } from "@/lib/menu-editor";
import { timeLabel } from "@/lib/local-day";

/**
 * The Menu tab (Matt, 2026-10-06: "updates need to be able to be made on
 * tablet"). The restaurant's menu as the CRM last pushed it; tap an item to
 * mark it sold out, put it back, change the price or rename it. Each tap is
 * one change sent to Premium (POST /api/dashboard/menu/changes); the item
 * shows "Sent to Premium" until the CRM has published it and pushed the
 * menu again. Nothing here changes the menu directly - the kitchen asks,
 * Premium's menu agent does it everywhere at once.
 *
 * With no menu pushed yet the tab falls back to words: a box that sends a
 * typed menu_change, the same way the chat's "Update menu" used to.
 */
const REFRESH_MS = 5 * 60_000;

type Loaded = { menu: TabletMenu | null; pushed_at: string | null; pending: string[] };

export default function MenuEditor({ timezone }: { timezone: string | null }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<TabletMenuItem | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/menu", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? "Could not load the menu.");
        return;
      }
      setError(null);
      setData({ menu: json.menu ?? null, pushed_at: json.pushed_at ?? null, pending: Array.isArray(json.pending) ? json.pending : [] });
    } catch {
      setError("Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const flash = (text: string) => {
    setSent(text);
    if (sentTimer.current) clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSent(null), 6_000);
  };

  const sendEdit = async (edit: MenuEdit): Promise<string | null> => {
    try {
      const res = await fetch("/api/dashboard/menu/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ menu_id: data?.menu?.menu_id, edits: [edit] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json?.code === "stale_menu" || json?.code === "no_menu") void load();
        return json?.error ?? "Didn't send. Try again.";
      }
      setData((d) => (d ? { ...d, pending: [...new Set([...d.pending, edit.ref])] } : d));
      flash(`Sent to Premium: ${json.message?.body ?? "menu change"}`);
      return null;
    } catch {
      return "No connection. Didn't send.";
    }
  };

  const categories = useMemo(() => (data?.menu ? filterMenu(data.menu, query) : []), [data, query]);
  const pending = useMemo(() => new Set(data?.pending ?? []), [data]);

  if (!data) {
    return (
      <div className="menu-tab">
        <p className="app-empty" role="status">{error ?? "Loading the menu…"}</p>
      </div>
    );
  }

  if (!data.menu) return <MenuInWords onSent={flash} sent={sent} />;

  const itemCount = data.menu.categories.reduce((n, c) => n + c.items.length, 0);

  return (
    <div className="menu-tab">
      <div className="menu-head">
        <div>
          <div className="menu-title">Your menu</div>
          <div className="menu-sub">
            <span className="num">{itemCount}</span> items · updated {data.pushed_at ? timeLabel(data.pushed_at, timezone) : "—"}. Tap an item to change it.
          </div>
        </div>
        <input
          className="menu-search"
          type="search"
          placeholder="Find an item"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find an item"
        />
      </div>

      {error && <p className="menu-note" role="status">{error} Showing the last menu we had.</p>}
      {sent && <p className="menu-sent" role="status">{sent}</p>}

      {categories.length === 0 && <p className="app-empty">Nothing matches “{query}”.</p>}
      {categories.map((c) => (
        <section key={c.ref} className="menu-cat">
          <h3 className="menu-cat-name">
            {c.name} <span className="menu-cat-n num">{c.items.length}</span>
          </h3>
          <div className="menu-items">
            {c.items.map((i) => (
              <button key={i.ref} type="button" className={`menu-item${i.available ? "" : " out"}`} onClick={() => setEditing(i)}>
                <span className="menu-item-name">{i.name}</span>
                <span className="menu-item-right">
                  {pending.has(i.ref) && <span className="menu-chip sent">Sent to Premium</span>}
                  {!i.available && <span className="menu-chip out">Sold out</span>}
                  <span className="menu-item-price num">{money(i.price_cents)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <EditSheet
          item={editing}
          pending={pending.has(editing.ref)}
          onClose={() => setEditing(null)}
          onSend={async (edit) => {
            const err = await sendEdit(edit);
            if (!err) setEditing(null);
            return err;
          }}
        />
      )}
    </div>
  );
}

function EditSheet({
  item,
  pending,
  onClose,
  onSend,
}: {
  item: TabletMenuItem;
  pending: boolean;
  onClose: () => void;
  onSend: (edit: MenuEdit) => Promise<string | null>;
}) {
  const [price, setPrice] = useState((item.price_cents / 100).toFixed(2));
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (edit: MenuEdit) => {
    setBusy(true);
    setError(null);
    const err = await onSend(edit);
    setBusy(false);
    if (err) setError(err);
  };

  const priceCents = parsePriceInput(price);
  const priceChanged = priceCents !== null && priceCents !== item.price_cents;
  const nameChanged = name.trim() !== "" && name.trim() !== item.name;

  return (
    <div className="msg-overlay" onClick={onClose}>
      <aside className="msg-panel menu-sheet" onClick={(e) => e.stopPropagation()} aria-label={`Change ${item.name}`}>
        <header className="msg-head">
          <div>
            <div className="msg-title">{item.name}</div>
            <div className="msg-sub">
              {money(item.price_cents)} · {item.available ? "On the menu" : "Sold out"}
              {pending ? " · a change is already with Premium" : ""}
            </div>
          </div>
          <button type="button" className="msg-close" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="menu-sheet-body">
          {item.description && <p className="menu-sheet-desc">{item.description}</p>}

          <div className="menu-sheet-section">
            <div className="menu-sheet-label">Availability</div>
            {item.available ? (
              <button type="button" className="btn menu-action danger" disabled={busy} onClick={() => run({ ref: item.ref, action: "sold_out" })}>
                Mark sold out
              </button>
            ) : (
              <button type="button" className="btn menu-action" disabled={busy} onClick={() => run({ ref: item.ref, action: "back_on" })}>
                Put back on the menu
              </button>
            )}
          </div>

          <div className="menu-sheet-section">
            <label className="menu-sheet-label" htmlFor="menu-price">
              Price
            </label>
            <div className="menu-sheet-row">
              <span className="menu-dollar">$</span>
              <input id="menu-price" className="menu-input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
              <button
                type="button"
                className="btn menu-action"
                disabled={busy || !priceChanged}
                onClick={() => priceCents !== null && run({ ref: item.ref, action: "set_price", price_cents: priceCents })}
              >
                Save price
              </button>
            </div>
            {price.trim() && priceCents === null && <p className="menu-field-err">Enter a price like 12.99</p>}
          </div>

          <div className="menu-sheet-section">
            <label className="menu-sheet-label" htmlFor="menu-name">
              Name
            </label>
            <div className="menu-sheet-row">
              <input id="menu-name" className="menu-input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              <button type="button" className="btn menu-action" disabled={busy || !nameChanged} onClick={() => run({ ref: item.ref, action: "rename", name: name.trim() })}>
                Rename
              </button>
            </div>
          </div>

          {error && <p className="msg-error" role="alert">{error}</p>}
          <p className="menu-sheet-foot">Premium checks each change and updates your menu on Zuppler, DoorDash and everywhere else. It shows here once it&apos;s live.</p>
        </div>
      </aside>
    </div>
  );
}

/** No menu on this tablet yet: send the change in words through the dispatch thread. */
function MenuInWords({ onSent, sent }: { onSent: (text: string) => void; sent: string | null }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "menu_change", body: draft }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? "Didn't send. Try again.");
        return;
      }
      setDraft("");
      onSent("Sent to Premium. They'll make the change and let you know in Messages.");
    } catch {
      setError("No connection. Didn't send.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="menu-tab">
      <div className="menu-head">
        <div>
          <div className="menu-title">Update your menu</div>
          <div className="menu-sub">Your menu isn&apos;t on this tablet yet. Tell Premium what changed and we&apos;ll update it everywhere.</div>
        </div>
      </div>
      {sent && <p className="menu-sent" role="status">{sent}</p>}
      <form
        className="menu-words"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} maxLength={1000} placeholder="One change per line, in your own words" />
        <ul className="msg-menu-examples">
          {MENU_CHANGE_EXAMPLES.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        {error && <p className="msg-error" role="alert">{error}</p>}
        <button type="submit" className="btn msg-send" disabled={busy || !draft.trim()}>
          {busy ? "Sending…" : "Send to Premium"}
        </button>
      </form>
    </div>
  );
}
