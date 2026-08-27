import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { collectSnapshot, evaluateHealth } from "@/lib/health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/crm/issues - what is wrong right now, for the CRM to display.
 *
 * Evaluated live rather than read back from monitor_alerts, because that table
 * is a record of what has been NOTIFIED, not of what is true: a problem that
 * appears between cron runs is real and absent from it. first_seen_at is
 * merged in where we have it, so the CRM can show how long something has been
 * broken without depending on that table for the list itself.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const now = new Date();
  const issues = evaluateHealth(await collectSnapshot(), now);

  const admin = supabaseAdmin();
  const { data: known } = await admin
    .from("monitor_alerts")
    .select("key, first_seen_at, notified_at")
    .is("resolved_at", null);
  const byKey = new Map((known ?? []).map((a: any) => [a.key, a]));

  return NextResponse.json({
    checked_at: now.toISOString(),
    counts: {
      critical: issues.filter((i) => i.severity === "critical").length,
      warning: issues.filter((i) => i.severity === "warning").length,
    },
    issues: issues.map((i) => ({
      ...i,
      first_seen_at: byKey.get(i.key)?.first_seen_at ?? null,
      notified_at: byKey.get(i.key)?.notified_at ?? null,
    })),
  });
}
