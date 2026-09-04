import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/gmail";
import { supabaseAdmin } from "@/lib/supabase-server";
import { SENDER_STATE } from "@/app/api/gmail/connect-sender/route";
import { SENDER_ADDRESS } from "@/lib/email-out";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Shows the sender refresh token ONCE, in the response body.
 *
 * Not as a redirect query parameter: that would put a long-lived credential
 * into browser history, the referrer header and every access log between here
 * and the browser. The body is the only place it can appear that none of
 * those retain.
 *
 * It is displayed rather than stored because it belongs in Vercel's encrypted
 * environment, which this process cannot write to - and a refresh token in a
 * database column would be a second copy in a place nobody is watching.
 */
function senderTokenPage(token: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Gmail sender connected</title>
<style>
 body{font:15px/1.6 system-ui,-apple-system,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a}
 code,pre{font-family:ui-monospace,Menlo,monospace}
 pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow-x:auto;user-select:all;word-break:break-all;white-space:pre-wrap}
 .warn{border-left:3px solid #b45309;padding-left:1rem;color:#7c2d12}
</style>
<h1>Gmail sender connected</h1>
<p>Granted <code>gmail.send</code> for <strong>${esc(SENDER_ADDRESS)}</strong>.</p>
<p class="warn">This token is shown <strong>once</strong> and is not stored anywhere.
Copy it now — if you lose it, run the connect flow again.</p>
<pre>${esc(token)}</pre>
<p>Set it in Vercel, then redeploy:</p>
<pre>vercel env add TICKET_EMAIL_REFRESH_TOKEN production
vercel --prod --yes</pre>
<p>Until it is set, email delivery records a send failure on every job and the
<code>email_send_failed</code> check will page.</p>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

/**
 * GET /api/auth/callback/google?code=...&state=<inbox_id>
 * Google redirects here after the restaurant grants (or denies) inbox access.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const inboxId = req.nextUrl.searchParams.get("state");
  const errorParam = req.nextUrl.searchParams.get("error");

  const redirectBase = req.nextUrl.origin;

  // --- sender grant: no inbox row, token is displayed not stored ---
  if (inboxId === SENDER_STATE) {
    if (errorParam || !code) {
      return NextResponse.redirect(`${redirectBase}/admin?gmail_sender=error`);
    }
    try {
      const tokens = await exchangeCodeForTokens(code);
      if (!tokens.refresh_token) {
        return NextResponse.redirect(`${redirectBase}/admin?gmail_sender=no_refresh_token`);
      }
      return senderTokenPage(tokens.refresh_token);
    } catch (err) {
      console.error("Gmail sender OAuth callback failed:", err);
      return NextResponse.redirect(`${redirectBase}/admin?gmail_sender=error`);
    }
  }

  if (errorParam || !code || !inboxId) {
    return NextResponse.redirect(
      `${redirectBase}/admin?gmail_connect=error`
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Happens if the account already granted consent before and Google
      // didn't re-issue a refresh_token. The admin route always requests
      // prompt=consent to avoid this, but we guard anyway.
      return NextResponse.redirect(
        `${redirectBase}/admin?gmail_connect=no_refresh_token`
      );
    }

    const admin = supabaseAdmin();
    const { error } = await admin
      .from("monitored_inboxes")
      .update({
        gmail_refresh_token: tokens.refresh_token,
        gmail_access_token: tokens.access_token,
        gmail_token_expiry: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
        is_active: true,
      })
      .eq("id", inboxId);

    if (error) throw error;

    return NextResponse.redirect(`${redirectBase}/admin?gmail_connect=success`);
  } catch (err) {
    console.error("Gmail OAuth callback failed:", err);
    return NextResponse.redirect(`${redirectBase}/admin?gmail_connect=error`);
  }
}
