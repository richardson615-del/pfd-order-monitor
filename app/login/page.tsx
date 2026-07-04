"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = useSearchParams();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = supabaseBrowser();
    const next = params.get("next") || "/dashboard";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}${next}`,
      },
    });
    if (error) setError(error.message);
    else setSent(true);
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
