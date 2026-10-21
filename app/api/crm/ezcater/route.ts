import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { EzCaterApiError } from "@/lib/ezcater-client";
import { EzCaterAdminError, sendOrderToKitchenNow, setKitchen, setLocation, syncCaterers } from "@/lib/ezcater-admin";
import { getEzCaterForCrm, orderWindow } from "@/lib/ezcater-crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The CRM's ezCater tab (2026-10-21), on CRM_WRITE_KEY.
 *
 * GET  /api/crm/ezcater?from=YYYY-MM-DD&to=YYYY-MM-DD
 *        locations (with link, on/off, kitchen), bridge restaurants, and the
 *        stored orders whose hand-off falls in the window (default 7 days
 *        back to 30 ahead). Never the webhook secret or a customer phone.
 * POST /api/crm/ezcater {action}
 *        sync | set_location | set_kitchen | send_to_kitchen - the same
 *        functions /admin/ezcater calls. The actor is the x-crm-actor header
 *        (the CRM session's email), never the body.
 */

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof EzCaterAdminError ? 409 : err instanceof EzCaterApiError ? 502 : 500;
  console.error("crm/ezcater:", message);
  return NextResponse.json({ error: message }, { status });
}

const actorOf = (req: NextRequest) => {
  const a = (req.headers.get("x-crm-actor") ?? "").trim();
  return a ? `crm:${a.slice(0, 200)}` : "crm";
};

export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const sp = new URL(req.url).searchParams;
  try {
    return NextResponse.json(await getEzCaterForCrm(orderWindow(sp.get("from"), sp.get("to"))));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";
  const actor = actorOf(req);
  const catererUuid = typeof body?.caterer_uuid === "string" ? body.caterer_uuid : "";
  try {
    switch (action) {
      case "sync":
        return NextResponse.json(await syncCaterers());
      case "set_location": {
        if (!catererUuid) return NextResponse.json({ error: "caterer_uuid is required" }, { status: 400 });
        const change: { restaurantId?: string | null; active?: boolean } = {};
        if (body && "restaurant_id" in body) change.restaurantId = typeof body.restaurant_id === "string" && body.restaurant_id ? body.restaurant_id : null;
        if (typeof body?.active === "boolean") change.active = body.active;
        // The subscriber's webhook is this deployment's own ingest route.
        await setLocation(catererUuid, change, actor, `${new URL(req.url).origin}/api/ingest/ezcater`);
        return NextResponse.json({ ok: true });
      }
      case "set_kitchen": {
        if (!catererUuid) return NextResponse.json({ error: "caterer_uuid is required" }, { status: 400 });
        const change: { sendToKitchen?: boolean; leadHours?: number } = {};
        if (typeof body?.send_to_kitchen === "boolean") change.sendToKitchen = body.send_to_kitchen;
        if (body?.kitchen_lead_hours !== undefined) change.leadHours = Number(body.kitchen_lead_hours);
        return NextResponse.json(await setKitchen(catererUuid, change, actor));
      }
      case "send_to_kitchen": {
        const orderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";
        if (!orderId) return NextResponse.json({ error: "order_id is required" }, { status: 400 });
        return NextResponse.json(await sendOrderToKitchenNow(orderId, actor));
      }
      default:
        return NextResponse.json({ error: `unknown action '${action}'` }, { status: 400 });
    }
  } catch (err) {
    return fail(err);
  }
}
