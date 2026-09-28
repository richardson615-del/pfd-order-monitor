import { NextRequest, NextResponse } from "next/server";
import { isCurrentUserAdmin } from "@/lib/authz";
import { supabaseServer } from "@/lib/supabase-server";
import { EzCaterApiError } from "@/lib/ezcater-client";
import { EzCaterAdminError, applySeed, dryRunOrder, ensureSubscriber, getEzCaterState, setLocation, syncCaterers } from "@/lib/ezcater-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET  /api/admin/ezcater          the page's state (never the webhook secret)
 * POST /api/admin/ezcater {action}
 *   sync                            run ezCater's Caterers query, upsert every location
 *   apply_seed                      link the six known locations to their restaurants (never activates)
 *   set_location {caterer_uuid, restaurant_id?, active?}
 *                                   link / unlink; on = subscribe + ingest, off = unsubscribe
 *   create_subscriber               create THE subscriber (store its one-time secret)
 *   dry_run {order_id}              fetch + map one order, store nothing
 *
 * Admins only (the `admins` table). The webhook URL is this deployment's own
 * /api/ingest/ezcater, so the subscriber is created from the production site.
 */

async function actor(): Promise<string> {
  const { data } = await supabaseServer().auth.getUser();
  return data.user?.email ?? "admin";
}

const webhookUrlFor = (req: NextRequest) => `${new URL(req.url).origin}/api/ingest/ezcater`;

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof EzCaterAdminError ? 409 : err instanceof EzCaterApiError ? 502 : 500;
  console.error("admin/ezcater:", message);
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  if (!(await isCurrentUserAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await getEzCaterState());
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";
  try {
    switch (action) {
      case "sync":
        return NextResponse.json(await syncCaterers());
      case "apply_seed":
        return NextResponse.json({ outcomes: await applySeed(await actor()) });
      case "create_subscriber":
        return NextResponse.json(await ensureSubscriber(webhookUrlFor(req), await actor()));
      case "set_location": {
        const catererUuid = typeof body?.caterer_uuid === "string" ? body.caterer_uuid : "";
        if (!catererUuid) return NextResponse.json({ error: "caterer_uuid is required" }, { status: 400 });
        const change: { restaurantId?: string | null; active?: boolean } = {};
        if ("restaurant_id" in body) change.restaurantId = typeof body.restaurant_id === "string" && body.restaurant_id ? body.restaurant_id : null;
        if (typeof body.active === "boolean") change.active = body.active;
        await setLocation(catererUuid, change, await actor(), webhookUrlFor(req));
        return NextResponse.json({ ok: true });
      }
      case "dry_run": {
        const orderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";
        if (!orderId) return NextResponse.json({ error: "order_id is required" }, { status: 400 });
        return NextResponse.json(await dryRunOrder(orderId));
      }
      default:
        return NextResponse.json({ error: `unknown action '${action}'` }, { status: 400 });
    }
  } catch (err) {
    return fail(err);
  }
}
