"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { parseSetPasswordParams } from "@/lib/owner-invite";
import { MIN_PASSWORD_LENGTH } from "@/lib/usernames";
import { Brand } from "@/components/Brand";

/**
 * Where an owner's login email lands (lib/owner-invite.ts).
 *
 * Loading this page spends nothing. The link's token is only exchanged when
 * the owner presses the button, by verifyOtp, so a mail scanner that opens the
 * link first leaves it working. Then updateUser sets the password they chose
 * and they go to the dashboard, signed in.
 */
function SetPasswordForm() {
  const params = useSearchParams();
  const link = parseSetPasswordParams(params);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(!link);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!link) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const supabase = supabaseBrowser();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: link.tokenHash,
        type: link.type,
      });
      if (verifyError) {
        setDead(true);
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      // Full navigation so the server sees the new session cookies.
      window.location.assign("/dashboard");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="login-brand">
        <Brand size="lg" onLight withSubtitle />
      </div>
      <div className="login-card">
        {dead ? (
          <div className="form">
            <h2 style={{ margin: 0 }}>This link has stopped working</h2>
            <p className="muted">
              Login links work once and expire. Go to the sign-in page and choose &quot;Email me a
              sign-in link&quot;, or ask Premium to send a new one.
            </p>
            <a className="btn primary" href="/login">
              Go to sign in
            </a>
          </div>
        ) : (
          <form className="form" onSubmit={submit}>
            <h2 style={{ margin: 0 }}>Choose your password</h2>
            <p className="muted">You&apos;ll use it with your email address to sign in from now on.</p>
            <label htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label htmlFor="confirm">Type it again</label>
            <input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <div className="error-text">{error}</div>}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Set my password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPasswordForm />
    </Suspense>
  );
}
