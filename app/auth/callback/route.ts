import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

/**
 * GET /auth/callback?code=...&next=/dashboard
 * Supabase's magic-link email points here. We exchange the one-time code
 * for a real session (stored in cookies), then redirect on to wherever the
 * user was trying to go.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const next = req.nextUrl.searchParams.get("next") || "/dashboard";

  if (code) {
    const supabase = supabaseServer();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL(next, req.nextUrl.origin));
}
