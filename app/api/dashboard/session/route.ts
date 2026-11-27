import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/session (HP1, 2026-11-27)
 *
 * "Does the server still see a signed-in user on this browser?" - 200 or
 * 401, nothing else. The order screen asks only when its own session store
 * comes up empty or the database refuses its token (lib/order-sync.ts
 * sessionVerdict), so it can tell "signed out" from "no orders": the
 * database answers a signed-out browser with an empty list, not an error.
 * Reads nothing but the session, and returns nothing about it.
 */
export async function GET() {
  const {
    data: { user },
    error,
  } = await supabaseServer().auth.getUser();
  // The sign-in service itself failing is not "signed out": a 401 here sends
  // a screen to sign-in, so only a real refusal may produce one.
  const status = (error as { status?: number } | null)?.status;
  if (!user && error && (typeof status !== "number" || status === 0 || status >= 500)) {
    return NextResponse.json({ error: "session check unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!user) return NextResponse.json({ signed_in: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ signed_in: true }, { headers: { "Cache-Control": "no-store" } });
}
