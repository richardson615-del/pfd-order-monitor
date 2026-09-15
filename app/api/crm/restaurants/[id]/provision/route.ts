import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { provisionRestaurant } from "@/lib/provision";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id/provision
 * body: { actor? }
 *
 * The bridge half of "go live on the tablet", as one call: make sure the
 * restaurant is active, turn the tablet on (app_expected), create a login
 * if there is none, and report the printers and destinations so the CRM
 * can decide where the credentials go. Idempotent - a second call changes
 * nothing and says so in `changed: []`. Never resets a password.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;

  try {
    const result = await provisionRestaurant(params.id, actor);
    if (!result) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
