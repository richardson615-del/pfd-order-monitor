import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

/**
 * GET /auth/callback?code=...&next=/dashboard
 *
 * Supabase's sign-in email points here. We exchange the one-time code for a
 * real session (stored in cookies), then redirect on to wherever the user was
 * trying to go.
 *
 * Every failure used to end the same way: redirect to /dashboard regardless,
 * no session, middleware bounces to /login, and the person is looking at the
 * form they started from with no idea why. Three completely different
 * problems - a link carrying no code, an expired code, and a redirect URL
 * missing from Supabase's allowlist - were indistinguishable, and all three
 * read as "it just didn't work".
 *
 * Each now says what happened. None of them can be fixed by the person
 * clicking the link, so the message's job is to tell them what to ask for.
 */

/** Sends the user back to the form with something to read. */
function fail(req: NextRequest, reason: string) {
  const url = new URL("/login", req.nextUrl.origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const next = params.get("next") || "/dashboard";

  // Supabase reports a refused link in the query string rather than by
  // failing the request. An expired or already-used link arrives here.
  const supabaseError = params.get("error_description") || params.get("error");
  if (supabaseError) return fail(req, supabaseError);

  if (!code) {
    // Two real causes, and the user cannot tell them apart, so name both.
    //
    // The link carried its tokens in a URL FRAGMENT (#access_token=...),
    // which a browser never sends to a server - so this route cannot see
    // them whatever it does. That happens when the project is on the
    // implicit flow, or when the email was a signup confirmation rather than
    // a sign-in link.
    //
    // Or the redirect URL is missing from Supabase's allowlist, in which case
    // Supabase quietly substitutes the Site URL and the code never travels.
    return fail(
      req,
      "That link didn't carry a sign-in code. Ask PFD to check the Redirect URLs allowlist in Supabase, and that this address was invited rather than signed up."
    );
  }

  const supabase = supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Overwhelmingly the ordinary case: the link was used already, or it has
    // expired. Say the fix, not the error code.
    return fail(
      req,
      "That sign-in link has expired or was already used. Request a new one below."
    );
  }

  return NextResponse.redirect(new URL(next, req.nextUrl.origin));
}
