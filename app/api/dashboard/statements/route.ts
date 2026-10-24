import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import type { StatementView } from "@/lib/statements";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/statements -> { statements: StatementView[], pushed_at }
 *
 * The Money tab's read (migration 051): the weeks as the CRM last pushed
 * them, through the session client so RLS applies - a restaurant sees its
 * own weeks and nobody else's. Newest first. `payload` is not returned
 * here; the page shows the summary columns and opens the CRM's statement
 * link for the rest.
 */
export async function GET() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const { data, error } = await supabase
    .from("restaurant_statements")
    .select("period_start, period_end, statement_no, payment_status, paid_at, payment_date, order_count, amount_due_cents, view_url, pdf_url, pushed_at")
    .eq("restaurant_id", restaurantId)
    .order("period_start", { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as (StatementView & { pushed_at: string })[];
  const pushedAt = rows.reduce<string | null>((m, r) => (m && m > r.pushed_at ? m : r.pushed_at), null);
  const statements: StatementView[] = rows.map(({ pushed_at: _p, ...r }) => r);
  return NextResponse.json({ statements, pushed_at: pushedAt }, { headers: { "Cache-Control": "no-store" } });
}
