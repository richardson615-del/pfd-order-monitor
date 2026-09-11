"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const params = useSearchParams();
  // Anything /auth/callback could not complete arrives here as a sentence.
  const [error, setError] = useState<string | null>(params.get("error"));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = supabaseBrowser();
    const next = params.get("next") || "/dashboard";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // This app is invite-only: an admin adds a restaurant login, which
        // creates the auth user. Left at its default, this call CREATES an
        // account for any address typed in - and because that account is new,
        // Supabase sends a "confirm your email" rather than a sign-in link.
        // Clicking it lands back on this form, having quietly made a user
        // belonging to no restaurant. That is the exact dead end this page
        // produced before.
        shouldCreateUser: false,
      },
    });
    if (error) {
      // "Signups not allowed for otp" is Supabase telling us the address has
      // never been invited. True, and useless to read - the person needs to
      // know who can fix it.
      setError(
        /signups? not allowed/i.test(error.message)
          ? "This email address hasn't been set up yet. Ask PFD to add it to your restaurant, then try again."
          : error.message
      );
    } else setSent(true);
  }

  return (
    <div className="page">
      <div className="topbar" style={{ position: "static" }}>
        <h1>PFD Order Monitor</h1>
      </div>
      <div style={{ padding: 16 }}>
        {sent ? (
          <div className="card">
            <p>
              Check <strong>{email}</strong> for a sign-in link.
            </p>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            <label>Email address</label>
            <input
              type="email"
              required
              placeholder="you@restaurant.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {error && <div className="error-text">{error}</div>}
            <button className="btn primary" type="submit">
              Send sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
