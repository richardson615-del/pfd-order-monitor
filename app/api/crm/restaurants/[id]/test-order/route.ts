import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { sendTestOrder } from "@/lib/test-order";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id/test-order
 *
 * Sends a test order to the restaurant's tablet and printer, from the
 * office. The rule - what it writes, what it refuses, what it reports -
 * lives in lib/test-order.ts, because the tablet's own Ready screen sends
 * the same order (POST /api/dashboard/test-order) and the two must not
 * drift.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const result = await sendTestOrder(params.id);
  return NextResponse.json(result.body, { status: result.status });
}
