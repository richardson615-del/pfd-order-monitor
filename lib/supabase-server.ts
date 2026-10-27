import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { bearerToken } from "./partner-app";

// Use in Server Components / Route Handlers - respects the logged-in user's session + RLS.
// IMPORTANT: never import this file from a "use client" component.
export function supabaseServer() {
  // PFD Partner (PA1): the owner's phone app sends the restaurant login's
  // access token as a Bearer header instead of cookies. Same user, same RLS;
  // getUser() is pointed at that token so every route that asks "who is
  // signed in" gets the same answer it would from the tablet's cookie.
  const bearer = bearerFromRequest();
  if (bearer) {
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${bearer}` },
        fetch: (input: any, init?: any) => fetch(input, { ...init, cache: "no-store" }),
      },
    });
    const getUser = client.auth.getUser.bind(client.auth);
    (client.auth as any).getUser = (jwt?: string) => getUser(jwt ?? bearer);
    return client as unknown as ReturnType<typeof createServerClient>;
  }
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // called from a Server Component - safe to ignore, middleware handles refresh
          }
        },
        remove(name: string, options: any) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // ignore, see above
          }
        },
      },
    }
  );
}

// Use ONLY in trusted server-side code (cron/poll route, admin API routes).
// This bypasses Row Level Security - never expose this client or key to the browser.
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      // Next.js patches global fetch and caches GET requests in the (durable,
      // cross-deployment) Data Cache. That silently froze every read here -
      // the cron poll kept seeing a stale monitored_inboxes snapshot while its
      // writes went through, so deactivated inboxes were still polled and new
      // ones were invisible. Reads of live operational data must never cache.
      global: {
        fetch: (input: any, init?: any) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
    }
  );
}

/** The Bearer token on the current request, if any (outside a request: none). */
function bearerFromRequest(): string | null {
  try {
    return bearerToken(headers().get("authorization"));
  } catch {
    return null;
  }
}
