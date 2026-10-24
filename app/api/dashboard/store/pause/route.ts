import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_ZONE, storeSession } from "@/lib/store-session";
import { PAUSE_RATE_LIMIT, livePause, parsePause, pauseMessageBody } from "@/lib/store";
import { RATE_WINDOW_MS } from "@/lib/messages";

export const dynamic = "force-dynamic";

/**
 * POST /api/dashboard/store/pause { choice: "15"|"30"|"60"|"120"|"today", reason? } | { resume: true }
 *
 * The kitchen pauses (or resumes) online orders (migration 052). Sets the
 * restaurant's own columns and writes a `pause` message, so the CRM's feed
 * carries it within a minute: the CRM stops taking web, Muse and phone
 * orders for the restaurant and opens a ticket for dispatch to pause the
 * other ordering sites. Resuming when nothing is paused is a no-op 200.
 */
export async function POST(req: NextRequest) {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const admin = supabaseAdmin();
  const now = new Date();
  const { data: r, error: rErr } = await admin.from("restaurants").select("timezone, online_paused_until, online_pause_reason, online_paused_at").eq("id", s.restaurantId).single();
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
  const zone = r.timezone ?? DEFAULT_ZONE;
  const d = parsePause(await req.json().catch(() => ({})), now, zone);
  if (d.kind === "error") return NextResponse.json({ error: d.error }, { status: 400 });
  if (d.kind === "resume" && !livePause(r, now)) return NextResponse.json({ pause: null, changed: false });

  const { count } = await admin
    .from("restaurant_messages")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", s.restaurantId)
    .eq("kind", "pause")
    .gte("created_at", new Date(now.getTime() - RATE_WINDOW_MS).toISOString());
  if ((count ?? 0) >= PAUSE_RATE_LIMIT) return NextResponse.json({ error: "That's a lot of pause changes. Call dispatch if something's wrong." }, { status: 429 });

  const cols = d.kind === "resume"
    ? { online_paused_until: null, online_pause_reason: null, online_paused_at: null }
    : { online_paused_until: d.until.toISOString(), online_pause_reason: d.reason, online_paused_at: now.toISOString() };
  const { error: upErr } = await admin.from("restaurants").update(cols).eq("id", s.restaurantId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  const { error: msgErr } = await admin.from("restaurant_messages").insert({
    restaurant_id: s.restaurantId,
    direction: "from_restaurant",
    kind: "pause",
    body: pauseMessageBody(d, zone),
    details: d.kind === "resume" ? { paused_until: null, reason: null } : { paused_until: d.until.toISOString(), reason: d.reason },
  });
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });
  return NextResponse.json({ pause: d.kind === "resume" ? null : { until: cols.online_paused_until, reason: cols.online_pause_reason, at: cols.online_paused_at }, changed: true });
}
