import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/devices/:id/history?limit=25
 *
 * What this bridge can and cannot tell you about a device:
 *
 *   print jobs   - YES. One row per ticket, with queued / claimed / finished
 *                  timestamps and any error. This is real history.
 *   key actions  - YES. Every reveal and reissue, with actor.
 *   check-ins    - NO. Only last_seen_at, a single overwritten timestamp.
 *                  A printer polls every 5 seconds, so retaining each check-in
 *                  would be ~17k rows per device per day to record that
 *                  nothing happened. The job timeline already shows whether
 *                  the device was alive, at the moments it mattered.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 25)));
  const admin = supabaseAdmin();

  const { data: device } = await admin
    .from("print_devices")
    .select("id, name, is_active, last_seen_at, printer_name, app_version, created_at")
    .eq("id", params.id)
    .maybeSingle();
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  const [jobsRes, auditRes] = await Promise.all([
    admin.from("print_jobs")
      .select("id, status, attempts, error, queued_at, claimed_at, finished_at, orders(order_number, customer_total, order_type)")
      .eq("device_id", params.id)
      .order("queued_at", { ascending: false })
      .limit(limit),
    admin.from("device_key_audit")
      .select("action, actor, note, created_at")
      .eq("device_id", params.id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const jobs = (jobsRes.data ?? []).map((j: any) => {
    const q = new Date(j.queued_at).getTime();
    const c = j.claimed_at ? new Date(j.claimed_at).getTime() : null;
    const f = j.finished_at ? new Date(j.finished_at).getTime() : null;
    return {
      id: j.id,
      status: j.status,
      attempts: j.attempts,
      error: j.error,
      order_number: j.orders?.order_number ?? null,
      order_total: j.orders?.customer_total ?? null,
      order_type: j.orders?.order_type ?? null,
      queued_at: j.queued_at,
      claimed_at: j.claimed_at,
      finished_at: j.finished_at,
      // Precomputed so every view agrees on what "slow" means.
      seconds_to_claim: c ? Math.round(((c - q) / 1000) * 10) / 10 : null,
      seconds_to_print: c && f ? Math.round(((f - c) / 1000) * 10) / 10 : null,
    };
  });

  return NextResponse.json({
    device,
    print_jobs: jobs,
    key_actions: auditRes.data ?? [],
    check_in_history: {
      available: false,
      last_seen_at: device.last_seen_at,
      reason:
        "Not retained. A printer polls every 5 seconds, so per-check-in rows would be roughly 17,000 per device per day to record that nothing happened. Use last_seen_at for liveness and the print job timeline for what actually occurred.",
    },
  });
}
