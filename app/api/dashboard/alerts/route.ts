import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { storeSession } from "@/lib/store-session";
import { collectSnapshot, evaluateHealth, type HealthIssue } from "@/lib/health";
import { kitchenAlerts, kitchenAlertBanner } from "@/lib/kitchen-alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/dashboard/alerts -> { alerts: KitchenAlert[], banner: string | null, checked_at }
 *
 * KT1 (prs-crm Ticket #779): the signed-in restaurant's own printer and
 * tablet alerts, for the Store tab's list and the banner over the orders.
 * The same evaluation GET /api/crm/issues runs, filtered to the session's
 * restaurant and put in the kitchen's words (lib/kitchen-alerts.ts). The
 * restaurant comes from the session, never the request.
 *
 * The evaluation is fleet-wide, so it is kept for a minute per instance:
 * every tablet polling does not mean a health check per tablet.
 */
const CACHE_MS = 60_000;
let cached: { at: number; issues: HealthIssue[] } | null = null;

async function currentIssues(now: Date): Promise<HealthIssue[]> {
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.issues;
  const issues = evaluateHealth(await collectSnapshot(), now);
  cached = { at: now.getTime(), issues };
  return issues;
}

export async function GET() {
  const s = await storeSession();
  if ("error" in s) return s.error;
  const now = new Date();
  try {
    const issues = await currentIssues(now);
    const mine = issues.filter((i) => i.restaurant_id === s.restaurantId);
    const keys = mine.map((i) => i.key);
    const { data: stamps } = keys.length
      ? await supabaseAdmin().from("monitor_alerts").select("key, first_seen_at").in("key", keys).is("resolved_at", null)
      : { data: [] as { key: string; first_seen_at: string | null }[] };
    const firstSeen = new Map((stamps ?? []).map((r: { key: string; first_seen_at: string | null }) => [r.key, r.first_seen_at]));
    const alerts = kitchenAlerts(mine, s.restaurantId, firstSeen);
    return NextResponse.json({ alerts, banner: kitchenAlertBanner(alerts), checked_at: now.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not check the printer and tablet." }, { status: 500 });
  }
}
