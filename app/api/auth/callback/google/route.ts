import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/gmail";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * GET /api/auth/callback/google?code=...&state=<inbox_id>
 * Google redirects here after the restaurant grants (or denies) inbox access.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const inboxId = req.nextUrl.searchParams.get("state");
  const errorParam = req.nextUrl.searchParams.get("error");

  const redirectBase = req.nextUrl.origin;

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
