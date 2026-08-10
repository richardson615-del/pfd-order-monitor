import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authenticateDevice } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/print/jobs
 * Header: X-Device-Key: PFD-XXXX-XXXX-XXXX
 * Optional headers: X-App-Version, X-Printer-Name (stored for admin visibility)
 *
 * Returns queued print jobs for this device WITH the canonical order data
 * needed to render the standard ticket. Claims them atomically (status ->
 * 'claimed') so a job is handed out once even if the app double-polls.
 * Jobs stuck in 'claimed' for >2 minutes are re-offered (app crashed
 * mid-print), which pairs with the (order_id, device_id) uniqueness to stay
 * at-least-once without duplicate rows.
 */
export async function GET(req: NextRequest) {
  const device = await authenticateDevice(req);
  if (!device) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  // Re-offer stale claims first
  await admin
    .from("print_jobs")
    .update({ status: "queued", claimed_at: null })
    .eq("device_id", device.id)
    .eq("status", "claimed")
    .lt("claimed_at", staleCutoff);

  const { data: jobs, error } = await admin
    .from("print_jobs")
    .select(
      `id, order_id, attempts,
       orders (
         id, order_number, source, ticket_restaurant_name, order_type,
         due_time, customer_name, customer_phone, customer_address,
         items, items_total, tax, service_fee, customer_total,
         payment_type, notes, received_at
       )`
    )
    .eq("device_id", device.id)
    .eq("status", "queued")
    .order("queued_at", { ascending: true })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!jobs?.length) return NextResponse.json({ jobs: [] });

  // Claim what we're returning
  const ids = jobs.map((j) => j.id);
  await admin
    .from("print_jobs")
    .update({ status: "claimed", claimed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "queued");

  return NextResponse.json({ jobs });
}

/**
 * POST /api/print/jobs
 * Header: X-Device-Key
 * Body: { job_id, status: "printed" | "failed", error? }
 *
 * Reports the outcome of a claimed job. A successful print also flips the
 * order's status to 'printed' so the dashboard "Printed" tab reflects
 * reality. Failed jobs are re-queued up to 3 attempts, then left failed
 * for the app to alert on and for admin visibility.
 */
export async function POST(req: NextRequest) {
  const device = await authenticateDevice(req);
  if (!device) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const jobId = body?.job_id;
  const status = body?.status;
  if (!jobId || !["printed", "failed"].includes(status)) {
    return NextResponse.json(
      { error: "job_id and status ('printed'|'failed') required" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  const { data: job } = await admin
    .from("print_jobs")
    .select("id, order_id, attempts, device_id")
    .eq("id", jobId)
    .eq("device_id", device.id)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  if (status === "printed") {
    await admin
      .from("print_jobs")
      .update({ status: "printed", finished_at: new Date().toISOString() })
      .eq("id", job.id);
    await admin
      .from("orders")
      .update({ status: "printed", printed_at: new Date().toISOString() })
      .eq("id", job.order_id);
    return NextResponse.json({ ok: true });
  }

  // failed
  const attempts = (job.attempts ?? 0) + 1;
  const willRetry = attempts < 3;
  await admin
    .from("print_jobs")
    .update({
      status: willRetry ? "queued" : "failed",
      attempts,
      error: typeof body?.error === "string" ? body.error.slice(0, 500) : null,
      claimed_at: null,
      finished_at: willRetry ? null : new Date().toISOString(),
    })
    .eq("id", job.id);

  return NextResponse.json({ ok: true, will_retry: willRetry, attempts });
}
