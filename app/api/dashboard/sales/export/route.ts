import { NextRequest, NextResponse } from "next/server";
import { parseSalesRange, salesCsv, salesCsvName } from "@/lib/sales";
import { fetchSalesOrders, salesCaller } from "@/lib/sales-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/sales/export?from=...&to=... (PA6)
 *
 * The same range as a CSV for the restaurant's bookkeeper: one line per
 * order, cancelled ones included and marked, oldest first. Customer first
 * name only; never a phone or address.
 */
export async function GET(req: NextRequest) {
  const caller = await salesCaller();
  if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const sp = req.nextUrl.searchParams;
  const parsed = parseSalesRange(sp.get("from"), sp.get("to"), Date.now(), caller.timezone);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const fetched = await fetchSalesOrders(caller, parsed.range);
  if ("error" in fetched) return NextResponse.json({ error: fetched.error }, { status: 500 });
  if (fetched.truncated) return NextResponse.json({ error: "Too many orders for one file. Pick a shorter range." }, { status: 413 });

  return new NextResponse(salesCsv(fetched.orders, parsed.range, caller.timezone), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${salesCsvName(parsed.range)}"`,
      "Cache-Control": "no-store",
    },
  });
}
