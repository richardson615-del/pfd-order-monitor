"use client";

import { useState } from "react";

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
  monitored_inboxes: Inbox[];
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
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [inviteRestaurantId, setInviteRestaurantId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  async function createRestaurant(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/admin/restaurants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, monitored_email: email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create");
      setRestaurants((prev) => [
        { ...data.restaurant, monitored_inboxes: [data.inbox] },
        ...prev,
      ]);
      setName("");
      setSlug("");
      setEmail("");
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
            <label>Monitored inbox (the Gmail address receiving PFD order emails)</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="sweezyspub@gmail.com"
            />
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
          <h2>Restaurants</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Monitored inbox</th>
                <th>Gmail status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {restaurants.map((r) =>
                r.monitored_inboxes.length ? (
                  r.monitored_inboxes.map((inbox) => (
                    <tr key={inbox.id}>
                      <td>{r.name}</td>
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
                    <td colSpan={3} className="muted">
                      No inbox configured
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
