import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authenticateDevice } from "@/lib/device-auth";
import { claimDecision, expiredReason, failureTransition, printMaxAgeMs, HOLD_RETRY_MS } from "@/lib/print-policy";

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

  // Held jobs (out of paper, cover open) come back after a couple of
  // minutes - same rule as the Epson transport, lib/print-policy.ts.
  await admin
    .from("print_jobs")
    .update({ status: "queued", claimed_at: null })
    .eq("device_id", device.id)
    .eq("status", "held")
    .lt("held_at", new Date(Date.now() - HOLD_RETRY_MS).toISOString());

  const { data: jobs, error } = await admin
    .from("print_jobs")
    .select(
      `id, order_id, attempts, manual_reprint_at,
       orders (
         id, order_number, source, ticket_restaurant_name, order_type,
         due_time, customer_name, customer_phone, customer_address,
         items, items_total, tax, service_fee, delivery_fee, tip,
         customer_total, payment_type, notes, received_at
       )`
    )
    .eq("device_id", device.id)
    .eq("status", "queued")
    // Orders only. The on-site agent (print-agent/agent.mjs) renders a ticket
    // from this order JSON and has never heard of a document job (migration
    // 029) - handing it one would be a job it claims, cannot draw, and
    // reports nothing about. The endpoint that queues documents refuses any
    // device that reports this transport, so in practice this filter should
    // never have anything to do; it is here so that "should" is not the only
    // thing standing between a login ticket and a silently lost job.
    .eq("kind", "order")
    .order("queued_at", { ascending: true })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!jobs?.length) return NextResponse.json({ jobs: [] });

  // Too old to print (PRINT_MAX_AGE_HOURS) is expired here, at claim time,
  // unless Print was pressed for it in the last ten minutes - the same rule
  // as the Epson transport. Never handed to the agent, never a ticket.
  const nowMs = Date.now();
  const maxAgeMs = printMaxAgeMs();
  const fresh: typeof jobs = [];
  for (const j of jobs as any[]) {
    if (claimDecision({ receivedAt: j.orders?.received_at, manualReprintAt: j.manual_reprint_at, now: nowMs, maxAgeMs }) === "expire") {
      await admin
        .from("print_jobs")
        .update({ status: "expired", error: expiredReason(j.orders.received_at, nowMs), finished_at: new Date(nowMs).toISOString(), claimed_at: null })
        .eq("id", j.id)
        .eq("status", "queued");
      continue;
    }
    fresh.push(j);
  }
  if (!fresh.length) return NextResponse.json({ jobs: [] });

  // Claim what we're returning
  const ids = fresh.map((j) => j.id);
  await admin
    .from("print_jobs")
    .update({ status: "claimed", claimed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "queued");

  return NextResponse.json({ jobs: fresh });
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
    .select("id, order_id, attempts, device_id, held_since")
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
    // A document job has no order to flip (migration 029). The GET above does
    // not hand documents to this transport at all, so this is belt and
    // braces - but `.eq("id", null)` is not a no-op, it is a malformed query.
    if (job.order_id) {
      await admin
        .from("orders")
        .update({ status: "printed", printed_at: new Date().toISOString() })
        .eq("id", job.order_id);
    }
    return NextResponse.json({ ok: true });
  }

  // failed. The agent's error text is kept when it sent one; an ePOS code
  // in it is said in plain English and, for out-of-paper / cover-open,
  // holds the job for a person instead of spending an attempt.
  const agentError = typeof body?.error === "string" ? body.error.trim() : "";
  const codeInText = agentError.match(/\b(EPTR_[A-Z_]+|SchemaError|DeviceNotFound|PrintSystemError|E[XR]R?_TIMEOUT)\b/i)?.[1] ?? null;
  const nowIso = new Date().toISOString();
  const next = failureTransition({ code: codeInText ?? agentError, attempts: job.attempts ?? 0, heldSince: job.held_since, now: Date.now() });
  const willRetry = next.status !== "failed";
  await admin
    .from("print_jobs")
    .update({
      status: next.status,
      attempts: next.attempts,
      error: (codeInText ? next.error : agentError || next.error).slice(0, 500),
      claimed_at: null,
      finished_at: next.status === "failed" ? nowIso : null,
      ...(next.status === "held" ? { held_at: nowIso, held_since: job.held_since ?? nowIso } : {}),
    })
    .eq("id", job.id);

  return NextResponse.json({ ok: true, will_retry: willRetry, attempts: next.attempts, status: next.status });
}
