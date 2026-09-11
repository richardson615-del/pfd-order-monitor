"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { usernameToEmail } from "@/lib/usernames";

/**
 * Username and password.
 *
 * It was an emailed sign-in link, which is wrong for what this is. A kitchen
 * tablet is shared, runs in kiosk mode locked to one app, and no inbox on it
 * is being watched - so signing back in meant somebody finding an email on a
 * device that cannot easily show them one, while orders were arriving.
 *
 * The email-link form is still here, behind a link, because PFD's own admins
 * have real addresses and anyone who signed in before usernames existed still
 * has an account with no password. Removing it would lock them out.
 */
function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Anything /auth/callback could not complete arrives here as a sentence.
  const [error, setError] = useState<string | null>(params.get("error"));

  const [useEmailLink, setUseEmailLink] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [sent, setSent] = useState(false);

  const next = params.get("next") || "/dashboard";

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = supabaseBrowser();
      const { error } = await supabase.auth.signInWithPassword({
        // An entry containing "@" is treated as a real address, so admin
        // accounts and anyone from before usernames keep working.
        email: usernameToEmail(username),
        password,
      });
      if (error) {
        // Supabase says "Invalid login credentials" for a wrong password AND
        // for a username that does not exist. Deliberately not split apart:
        // this form is on the public internet, and confirming which usernames
        // exist is a favour to nobody except someone guessing.
        setError(
          "That username and password didn't match. Check with PFD if you're not sure of them."
        );
        return;
      }
      // A full navigation, not a router push: the session lives in cookies the
      // server must read, and a client-side transition would arrive before
      // they are set.
      window.location.assign(next);
    } catch {
      setError("Couldn't reach the server. Check this device's wifi and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email: linkEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // Invite-only: an admin creates the login. Left at its default this
        // CREATES an account for any address typed in, and a new account gets
        // a "confirm your email" rather than a sign-in link - which lands back
        // on this form having quietly made a user belonging to no restaurant.
        shouldCreateUser: false,
      },
    });
    if (error) {
      setError(
        /signups? not allowed/i.test(error.message)
          ? "That email address hasn't been set up yet. Ask PFD to add it."
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
        {error && (
          <div className="error-text" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}

        {!useEmailLink ? (
          <>
            <form className="form" onSubmit={signIn}>
              <label htmlFor="username">Username</label>
              <input
                id="username"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
                placeholder="swezeys"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />

              <label htmlFor="password">Password</label>
              <input
                id="password"
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              <button className="btn primary" disabled={busy} type="submit">
                {busy ? "Signing in..." : "Sign in"}
              </button>
            </form>

            <p className="muted" style={{ marginTop: 16 }}>
              Forgotten it? PFD can set a new one — there is no reset email for a
              kitchen login.{" "}
              <button
                className="link-button"
                type="button"
                onClick={() => {
                  setUseEmailLink(true);
                  setError(null);
                }}
              >
                Sign in with an email link instead
              </button>
            </p>
          </>
        ) : sent ? (
          <div className="card">
            <p>
              Check <strong>{linkEmail}</strong> for a sign-in link.
            </p>
          </div>
        ) : (
          <>
            <form className="form" onSubmit={sendLink}>
              <label htmlFor="linkEmail">Email address</label>
              <input
                id="linkEmail"
                required
                type="email"
                autoComplete="email"
                placeholder="you@pfdworks.com"
                value={linkEmail}
                onChange={(e) => setLinkEmail(e.target.value)}
              />
              <button className="btn primary" type="submit">
                Send sign-in link
              </button>
            </form>
            <p className="muted" style={{ marginTop: 16 }}>
              <button
                className="link-button"
                type="button"
                onClick={() => {
                  setUseEmailLink(false);
                  setError(null);
                }}
              >
                Back to username and password
              </button>
            </p>
          </>
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
