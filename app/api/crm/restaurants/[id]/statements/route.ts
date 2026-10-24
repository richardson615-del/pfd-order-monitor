import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { parseStatementsPush, statementOrigins } from "@/lib/statements";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PUT /api/crm/restaurants/:id/statements
 *   { statements: [{ period_start, period_end, statement_no, payment_status,
 *                    paid_at?, payment_date?, payment_ref?, order_count,
 *                    amount_due_cents, view_url?, pdf_url?, generated_at?, payload? }] }
 *
 * The CRM pushes a restaurant's closed weeks for the tablet app's Money tab
 * (migration 051). One row per week, replaced whole on every push; a week
 * the CRM stops sending is left as it was (history never vanishes from a
 * restaurant's page because a push got shorter). The CRM pushes when a
 * period closes, when a statement is sent or regenerated, and when a
 * payment is marked paid.
 *
 * GET returns what is held, for the CRM to check a push landed.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const parsed = parseStatementsPush(await req.json().catch(() => null), statementOrigins());
  if ("error" in parsed) return NextResponse.json({ error: parsed.error, code: "invalid" }, { status: 400 });

  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null }>(params.id, "id, crm_restaurant_id");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });

  const pushedAt = new Date().toISOString();
  if (parsed.statements.length > 0) {
    const { error } = await supabaseAdmin()
      .from("restaurant_statements")
      .upsert(
        parsed.statements.map((s) => ({ restaurant_id: restaurant.id, ...s, pushed_at: pushedAt })),
        { onConflict: "restaurant_id,period_start" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    restaurant_id: restaurant.id,
    crm_restaurant_id: restaurant.crm_restaurant_id,
    weeks: parsed.statements.length,
    pushed_at: pushedAt,
  });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null }>(params.id, "id, crm_restaurant_id");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });

  const { data, error } = await supabaseAdmin()
    .from("restaurant_statements")
    .select("period_start, period_end, statement_no, payment_status, amount_due_cents, pushed_at")
    .eq("restaurant_id", restaurant.id)
    .order("period_start", { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { restaurant_id: restaurant.id, crm_restaurant_id: restaurant.crm_restaurant_id, statements: data ?? [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
