import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/restaurants/:id/footer-stats?weeks=8
 *
 * Rendered / scanned / redeemed, by template and by week. This is the report
 * that says whether the feature is worth keeping, so it counts real events
 * rather than estimating from orders.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const weeks = Math.min(52, Math.max(1, Number(req.nextUrl.searchParams.get("weeks") || 8)));
  const since = new Date(Date.now() - weeks * 7 * 86_400_000);

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("footer_events")
    .select("template_id, kind, created_at")
    .eq("restaurant_id", params.id)
    .gte("created_at", since.toISOString());
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const totals: Record<string, Record<string, number>> = {};
  const byWeek: Record<string, Record<string, number>> = {};

  for (const e of rows as any[]) {
    totals[e.template_id] ??= {};
    totals[e.template_id][e.kind] = (totals[e.template_id][e.kind] ?? 0) + 1;
    // ISO week start (Monday), so weeks line up with how people read a rota.
    const d = new Date(e.created_at);
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    const key = monday.toISOString().slice(0, 10);
    byWeek[key] ??= {};
    byWeek[key][e.kind] = (byWeek[key][e.kind] ?? 0) + 1;
  }

  const rendered = rows.filter((e: any) => e.kind === "rendered").length;
  const scanned = rows.filter((e: any) => e.kind === "qr_scanned").length;

  return NextResponse.json({
    since: since.toISOString(),
    weeks,
    totals,
    by_week: Object.fromEntries(Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b))),
    summary: {
      rendered,
      scanned,
      // The headline number. Guarded against divide-by-zero rather than
      // reporting a scan rate for a footer nobody has printed yet.
      scan_rate: rendered ? Math.round((scanned / rendered) * 1000) / 10 : null,
    },
  });
}
