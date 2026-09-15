import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { collectSnapshot, evaluateHealth } from "@/lib/health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/crm/issues[?since=<iso>]
 *
 * What is wrong right now, and what stopped being wrong recently, in a
 * shape the CRM can turn into trouble tickets (E2):
 *
 *   - every issue has a deterministic `key` (evaluateHealth's), and where
 *     it is about one restaurant or one printer, `restaurant_id`,
 *     `crm_restaurant_id` (the CRM account, when linked) and `device_id`;
 *   - `first_seen_at` / `notified_at` come from monitor_alerts, which the
 *     five-minute monitor writes - so a brand-new issue on this live
 *     evaluation has null until that run has stamped it;
 *   - `resolved[]` lists keys that monitor_alerts closed in the last 24h
 *     (or since `since`), each with its `resolved_at`. Resolution is
 *     observed by the monitor run, not by this call: this endpoint reads
 *     the record, it does not write it, so two CRM polls in a row cannot
 *     disagree about whether something cleared.
 *
 * `since` narrows both lists to what changed after that instant (issues
 * first seen after it, resolutions after it). Issues with no stamp yet are
 * always included - they are, by definition, new.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const now = new Date();
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;
  const resolvedWindowStart = since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const snapshot = await collectSnapshot();
  const issues = evaluateHealth(snapshot, now);

  const admin = supabaseAdmin();
  const [{ data: known }, { data: resolvedRows }, { data: restaurantRows }] = await Promise.all([
    admin.from("monitor_alerts").select("key, first_seen_at, notified_at").is("resolved_at", null),
    admin
      .from("monitor_alerts")
      .select("key, severity, title, first_seen_at, resolved_at")
      .not("resolved_at", "is", null)
      .gte("resolved_at", resolvedWindowStart.toISOString())
      .order("resolved_at", { ascending: false })
      .limit(500),
    admin.from("restaurants").select("id, crm_restaurant_id"),
  ]);
  const byKey = new Map((known ?? []).map((a: any) => [a.key, a]));
  const crmIdOf = new Map((restaurantRows ?? []).map((r: any) => [r.id, r.crm_restaurant_id ?? null]));

  const shaped = issues.map((i) => {
    const stamp = byKey.get(i.key);
    return {
      key: i.key,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      restaurant_id: i.restaurant_id ?? null,
      crm_restaurant_id: i.restaurant_id ? (crmIdOf.get(i.restaurant_id) ?? null) : null,
      device_id: i.device_id ?? null,
      first_seen_at: stamp?.first_seen_at ?? null,
      notified_at: stamp?.notified_at ?? null,
    };
  });
  const current = since
    ? shaped.filter((i) => !i.first_seen_at || new Date(i.first_seen_at) >= since)
    : shaped;

  return NextResponse.json({
    checked_at: now.toISOString(),
    since: since?.toISOString() ?? null,
    counts: {
      critical: issues.filter((i) => i.severity === "critical").length,
      warning: issues.filter((i) => i.severity === "warning").length,
    },
    issues: current,
    resolved: (resolvedRows ?? []).map((r: any) => ({
      key: r.key,
      severity: r.severity,
      title: r.title,
      first_seen_at: r.first_seen_at,
      resolved_at: r.resolved_at,
    })),
  });
}
