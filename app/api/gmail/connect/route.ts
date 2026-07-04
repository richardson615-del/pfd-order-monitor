import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthUrl } from "@/lib/gmail";
import { supabaseServer } from "@/lib/supabase-server";
import { isCurrentUserAdmin } from "@/lib/authz";

/**
 * GET /api/gmail/connect?inbox_id=...
 * Admin-only. Redirects the browser to Google's consent screen. The
 * signed-in Google account must be the monitored inbox itself (e.g. the
 * restaurant's Gmail address) so PFD gets a refresh token for that mailbox.
 */
export async function GET(req: NextRequest) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const inboxId = req.nextUrl.searchParams.get("inbox_id");
  if (!inboxId) {
    return NextResponse.json({ error: "missing inbox_id" }, { status: 400 });
  }

  const url = getGoogleAuthUrl(inboxId);
  return NextResponse.redirect(url);
}
