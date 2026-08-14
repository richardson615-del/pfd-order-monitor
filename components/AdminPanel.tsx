"use client";

import { useEffect, useState } from "react";

interface Inbox {
  id: string;
  email_address: string;
  is_active: boolean;
  gmail_refresh_token: string | null;
}
interface Restaurant {
  id: string;
  name: string;
  slug: string;
  zuppler_restaurant_id: string | null;
  monitored_inboxes: Inbox[];
}
interface PrintDevice {
  id: string;
  restaurant_id: string;
  name: string;
  is_active: boolean;
  last_seen_at: string | null;
  printer_name: string | null;
  app_version: string | null;
}

export default function AdminPanel({
  initialRestaurants,
}: {
  initialRestaurants: Restaurant[];
}) {
  const [restaurants, setRestaurants] = useState(initialRestaurants);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [zupplerId, setZupplerId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [inviteRestaurantId, setInviteRestaurantId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  const [editingZuppler, setEditingZuppler] = useState<string | null>(null);
  const [zupplerDraft, setZupplerDraft] = useState("");
  const [zupplerError, setZupplerError] = useState<string | null>(null);

  async function saveZupplerId(restaurant: Restaurant) {
    setZupplerError(null);
    const res = await fetch("/api/admin/restaurants", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: restaurant.id, zuppler_restaurant_id: zupplerDraft }),
    });
    const data = await res.json();
    if (!res.ok) {
      setZupplerError(data.error || "Failed to save");
      return;
    }
    setRestaurants((prev) =>
      prev.map((r) =>
        r.id === restaurant.id
          ? { ...r, zuppler_restaurant_id: data.restaurant.zuppler_restaurant_id }
          : r
      )
    );
    setEditingZuppler(null);
  }

  const [devices, setDevices] = useState<PrintDevice[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [deviceRestaurantId, setDeviceRestaurantId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  // Shown once, right after registering. The key is not retrievable again.
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/admin/print-devices")
      .then((r) => r.json())
      .then((d) => setDevices(d.devices ?? []))
      .catch(() => {})
      .finally(() => setDevicesLoaded(true));
  }, []);

  async function registerDevice(e: React.FormEvent) {
    e.preventDefault();
    setRegistering(true);
    setDeviceError(null);
    setNewKey(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/print-devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restaurant_id: deviceRestaurantId, name: deviceName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to register device");
      setDevices((prev) => [{ ...data.device, is_active: true }, ...prev]);
      setNewKey({ name: data.device.name, key: data.device_key });
      setDeviceName("");
    } catch (err: any) {
      setDeviceError(err.message);
    } finally {
      setRegistering(false);
    }
  }

  async function toggleDevice(device: PrintDevice) {
    const next = !device.is_active;
    if (
      !next &&
      !confirm(
        `Deactivate "${device.name}"? It will stop printing immediately, and its key cannot be recovered - you would register a new device.`
      )
    ) {
      return;
    }
    const res = await fetch("/api/admin/print-devices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: device.id, is_active: next }),
    });
    if (res.ok) {
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, is_active: next } : d))
      );
    }
  }

  /** "3 min ago" - a printer that stopped checking in is the thing to notice. */
  function lastSeen(iso: string | null): { text: string; stale: boolean } {
    if (!iso) return { text: "never", stale: true };
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return { text: "just now", stale: false };
    if (mins < 60) return { text: `${mins} min ago`, stale: mins > 10 };
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return { text: `${hrs}h ago`, stale: true };
    return { text: `${Math.floor(hrs / 24)}d ago`, stale: true };
  }

  async function createRestaurant(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/admin/restaurants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          slug,
          monitored_email: email || undefined,
          zuppler_restaurant_id: zupplerId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create");
      setRestaurants((prev) => [
        { ...data.restaurant, monitored_inboxes: data.inbox ? [data.inbox] : [] },
        ...prev,
      ]);
      setName("");
      setSlug("");
      setEmail("");
      setZupplerId("");
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function inviteUser(e: React.FormEvent) {
    e.preventDefault();
    setInviteStatus("Sending...");
    const res = await fetch("/api/admin/restaurant-users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        restaurant_id: inviteRestaurantId,
        email: inviteEmail,
      }),
    });
    const data = await res.json();
    setInviteStatus(res.ok ? "Invite sent." : data.error);
  }

  function ZupplerCell({ r }: { r: Restaurant }) {
    if (editingZuppler === r.id) {
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            autoFocus
            value={zupplerDraft}
            onChange={(e) => setZupplerDraft(e.target.value)}
            placeholder="29905"
            inputMode="numeric"
            style={{ width: 90, padding: "4px 6px" }}
          />
          <button type="button" className="btn small" onClick={() => saveZupplerId(r)}>
            Save
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => { setEditingZuppler(null); setZupplerError(null); }}
          >
            Cancel
          </button>
          {zupplerError && <span className="error-text">{zupplerError}</span>}
        </span>
      );
    }
    return (
      <button
        type="button"
        className="btn small"
        title="Zuppler routes every order on this number"
        onClick={() => {
          setEditingZuppler(r.id);
          setZupplerDraft(r.zuppler_restaurant_id ?? "");
          setZupplerError(null);
        }}
      >
        {r.zuppler_restaurant_id ?? "Set ID"}
      </button>
    );
  }

  return (
    <div className="page">
      <div className="topbar">
        <h1>PFD Admin</h1>
      </div>

      <div style={{ padding: 16 }}>
        <div className="card">
          <h2>Add a restaurant</h2>
          <form className="form" onSubmit={createRestaurant}>
            <label>Restaurant name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Swezey's Pub"
            />
            <label>Slug (unique, no spaces)</label>
            <input
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="swezeys-pub"
            />
            <label>Monitored inbox (Gmail address receiving their order emails)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="sweezyspub@gmail.com"
            />
            <label>Zuppler restaurant ID</label>
            <input
              value={zupplerId}
              onChange={(e) => setZupplerId(e.target.value)}
              placeholder="29905"
              inputMode="numeric"
            />
            <p className="muted" style={{ margin: "-4px 0 4px", fontSize: 13 }}>
              Give an inbox, a Zuppler ID, or both - one of them is how orders
              reach this restaurant. Ask Jerry at Zuppler for the ID; it is five
              digits and cannot be guessed.
            </p>
            {createError && <div className="error-text">{createError}</div>}
            <button className="btn primary" disabled={creating} type="submit">
              {creating ? "Creating..." : "Create restaurant"}
            </button>
          </form>
        </div>

        <div className="card">
          <h2>Invite a restaurant login</h2>
          <form className="form" onSubmit={inviteUser}>
            <label>Restaurant</label>
            <select
              required
              value={inviteRestaurantId}
              onChange={(e) => setInviteRestaurantId(e.target.value)}
            >
              <option value="">Select a restaurant...</option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <label>Email to invite</label>
            <input
              required
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="owner@restaurant.com"
            />
            <button className="btn primary" type="submit">
              Send invite
            </button>
            {inviteStatus && <div className="muted">{inviteStatus}</div>}
          </form>
        </div>

        <div className="card">
          <h2>Print devices</h2>
          <p className="muted">
            One printer per restaurant. A restaurant with no active device
            here will ingest orders but never print them.
          </p>

          <form className="form" onSubmit={registerDevice}>
            <label>Restaurant</label>
            <select
              required
              value={deviceRestaurantId}
              onChange={(e) => setDeviceRestaurantId(e.target.value)}
            >
              <option value="">Select a restaurant...</option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <label>Device name</label>
            <input
              required
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Kitchen printer"
            />
            {deviceError && <div className="error-text">{deviceError}</div>}
            <button className="btn primary" disabled={registering} type="submit">
              {registering ? "Registering..." : "Register device"}
            </button>
          </form>

          {newKey && (
            <div className="card" style={{ marginTop: 16, borderColor: "#d9531e" }}>
              <h3 style={{ marginTop: 0 }}>Device key for {newKey.name}</h3>
              <p className="error-text">
                Copy this now - it is shown once and cannot be retrieved again.
              </p>
              <code
                style={{
                  display: "block",
                  padding: "12px",
                  fontSize: "18px",
                  letterSpacing: "1px",
                  wordBreak: "break-all",
                  background: "rgba(0,0,0,0.25)",
                  borderRadius: 6,
                }}
              >
                {newKey.key}
              </code>
              <button
                type="button"
                className="btn small"
                style={{ marginTop: 8 }}
                onClick={() => {
                  navigator.clipboard?.writeText(newKey.key);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy key"}
              </button>
              <p className="muted" style={{ marginTop: 12 }}>
                Epson (Server Direct Print): WebConfig &rarr; Web Service
                Settings &rarr; Direct Print. Set <strong>ID</strong> to this
                key, <strong>Server 1 URL</strong> to
                {" "}
                <code>https://pfd-order-monitor.vercel.app/api/print/epson</code>,
                interval 5s. Otherwise set <code>PFD_DEVICE_KEY</code> in the
                print agent.
              </p>
            </div>
          )}

          <table className="admin-table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Restaurant</th>
                <th>Device</th>
                <th>Printer</th>
                <th>Last seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!devicesLoaded && (
                <tr>
                  <td colSpan={5} className="muted">Loading devices...</td>
                </tr>
              )}
              {devicesLoaded && devices.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No print devices yet - orders will not print until one is registered.
                  </td>
                </tr>
              )}
              {devices.map((d) => {
                const seen = lastSeen(d.last_seen_at);
                const restaurant = restaurants.find((r) => r.id === d.restaurant_id);
                return (
                  <tr key={d.id} style={{ opacity: d.is_active ? 1 : 0.5 }}>
                    <td>{restaurant?.name ?? <span className="muted">unknown</span>}</td>
                    <td>
                      {d.name}
                      {!d.is_active && <span className="muted"> (inactive)</span>}
                    </td>
                    <td className="muted">
                      {d.printer_name || "-"}
                      {d.app_version ? ` / ${d.app_version}` : ""}
                    </td>
                    <td>
                      <span className={seen.stale ? "error-text" : "success-text"}>
                        {seen.text}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => toggleDevice(d)}
                      >
                        {d.is_active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Restaurants</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Zuppler ID</th>
                <th>Monitored inbox</th>
                <th>Gmail status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {restaurants.map((r) =>
                r.monitored_inboxes.length ? (
                  r.monitored_inboxes.map((inbox, i) => (
                    <tr key={inbox.id}>
                      <td>{r.name}</td>
                      {i === 0 && (
                        <td rowSpan={r.monitored_inboxes.length}>
                          <ZupplerCell r={r} />
                        </td>
                      )}
                      <td>{inbox.email_address}</td>
                      <td>
                        {inbox.gmail_refresh_token ? (
                          <span className="success-text">Connected</span>
                        ) : (
                          <span className="error-text">Not connected</span>
                        )}
                      </td>
                      <td>
                        <a
                          className="btn small"
                          href={`/api/gmail/connect?inbox_id=${inbox.id}`}
                        >
                          {inbox.gmail_refresh_token ? "Reconnect" : "Connect Gmail"}
                        </a>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td><ZupplerCell r={r} /></td>
                    <td colSpan={3} className="muted">
                      Zuppler only - no inbox
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
