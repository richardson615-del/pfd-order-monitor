import { NextRequest, NextResponse } from "next/server";
import { getGoogleSendAuthUrl, SENDER_STATE } from "@/lib/gmail";
import { supabaseServer } from "@/lib/supabase-server";
import { isCurrentUserAdmin } from "@/lib/authz";
import { SENDER_ADDRESS } from "@/lib/email-out";

export const dynamic = "force-dynamic";

/**
 * GET /api/gmail/connect-sender
 *
 * Admin-only. Sends the browser to Google for a gmail.send grant on the PFD
 * sending identity.
 *
 * Deliberately separate from /api/gmail/connect. That route asks a RESTAURANT
 * to grant read access to their own mailbox; this one asks for permission to
 * send as PFD. Bundling them would mean every restaurant connecting an inbox
 * was also approving send-as, which none of them should be asked for.
 *
 * You must be signed into Google as SENDER_ADDRESS when you land on the
 * consent screen - the grant belongs to whichever account approves it, and
 * approving as the wrong account produces a token that sends from the wrong
 * address with no error.
 */
export async function GET(_req: NextRequest) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.redirect(getGoogleSendAuthUrl(SENDER_STATE));
}
