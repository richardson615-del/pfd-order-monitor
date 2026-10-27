import { NextRequest, NextResponse } from "next/server";
import { parseSalesRange, salesReport } from "@/lib/sales";
import { fetchSalesOrders, salesCaller } from "@/lib/sales-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/sales?from=2026-10-01&to=2026-10-27 (PA6)
 *
 * The Sales tab, on the web portal and in the PFD Partner app: totals for
 * the range, a line per day, where orders came from, how they were paid,
 * best sellers, and every order (newest first) with anything to check.
 * Both dates are the restaurant's own days, inclusive; either may be left
 * out for today. Read-only, the restaurant from the session, RLS applies.
 */
export async function GET(req: NextRequest) {
  const caller = await salesCaller();
  if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const sp = req.nextUrl.searchParams;
  const parsed = parseSalesRange(sp.get("from"), sp.get("to"), Date.now(), caller.timezone);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const fetched = await fetchSalesOrders(caller, parsed.range);
  if ("error" in fetched) return NextResponse.json({ error: fetched.error }, { status: 500 });

  return NextResponse.json(salesReport(fetched.orders, parsed.range, Date.now(), caller.timezone, fetched.truncated), {
    headers: { "Cache-Control": "no-store" },
  });
}
