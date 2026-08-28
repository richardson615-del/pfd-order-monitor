import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { resolveOrCreateRestaurant } from "@/lib/restaurant-resolve";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/devices/:id   { action, ...args }
 *
 *   activate | deactivate
 *   rename      { name }
 *   reassign    { restaurant_id }
 *   test_print
 *
 * One endpoint with a named action rather than four verbs, so the CRM has a
 * single call to authorise and audit.
 */

const ACTIONS = ["activate", "deactivate", "rename", "reassign", "test_print", "set_text_scale"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "") as Action;
  if (!ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${ACTIONS.join(", ")}` },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  const { data: device } = await admin
    .from("print_devices")
    .select("id, name, is_active, restaurant_id, text_scale")
    .eq("id", params.id)
    .maybeSingle();
  if (!device) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }

  if (action === "activate" || action === "deactivate") {
    const isActive = action === "activate";
    const { error } = await admin
      .from("print_devices")
      .update({ is_active: isActive })
      .eq("id", device.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, device: { id: device.id, is_active: isActive } });
  }

  if (action === "set_text_scale") {
    // null is a real value here - "stop overriding, follow the restaurant" -
    // and is not the same as omitting the field.
    const raw = body?.text_scale;
    const scale = raw === null || raw === "" ? null : String(raw);
    if (scale !== null && scale !== "normal" && scale !== "large") {
      return NextResponse.json(
        { error: "text_scale must be 'normal', 'large', or null to inherit" },
        { status: 400 }
      );
    }
    const { error } = await admin
      .from("print_devices").update({ text_scale: scale }).eq("id", device.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, device: { id: device.id, text_scale: scale } });
  }

  if (action === "rename") {
    const name = String(body?.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    const { error } = await admin
      .from("print_devices")
      .update({ name })
      .eq("id", device.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, device: { id: device.id, name } });
  }

  if (action === "reassign") {
    // Same assumption as create: the restaurant being moved TO may equally
    // not exist here yet, and refusing the move would be the same dead end.
    const resolved = await resolveOrCreateRestaurant({
      restaurantId: body?.restaurant_id,
      crmRestaurantId: body?.crm_restaurant_id,
      restaurantName: body?.restaurant_name ?? body?.restaurant?.name,
    });
    if (!resolved.restaurant) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const target = resolved.restaurant;
    // The device_key deliberately survives a move: the printer follows the
    // hardware, and re-registering would issue a new key and mean a site visit.
    const { error } = await admin
      .from("print_devices")
      .update({ restaurant_id: target.id })
      .eq("id", device.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      ok: true,
      device: { id: device.id, restaurant: { id: target.id, name: target.name } },
      restaurant_created: resolved.created,
    });
  }

  // --- test_print ---------------------------------------------------------
  // Goes through the real pipeline: a real order row, a real print_jobs row,
  // claimed by the printer on its ordinary poll. A separate "just print this"
  // path would prove that path works and tell us nothing about the one that
  // carries actual orders.
  if (!device.is_active) {
    return NextResponse.json(
      {
        error:
          "device is inactive - the printer's poll is rejected while inactive, so the ticket would sit queued forever. Activate it first.",
      },
      { status: 409 }
    );
  }

  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("id", device.restaurant_id)
    .maybeSingle();

  const stamp = new Date();
  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      source: "test",
      external_id: `crm-test:${device.id}:${stamp.getTime()}`,
      restaurant_id: device.restaurant_id,
      order_number: `TEST-${stamp.getTime().toString(36).toUpperCase().slice(-6)}`,
      ticket_restaurant_name: restaurant?.name ?? null,
      order_type: "pickup",
      customer_name: "CRM test print",
      items: [
        { name: "Test ticket", price: "$0.00", modifiers: [`Device: ${device.name}`] },
      ],
      items_total: 0,
      customer_total: 0,
      notes: "Test print issued from the CRM. Not a real order - do not make.",
      received_at: stamp.toISOString(),
      status: "new",
    })
    .select("id, order_number")
    .single();
  if (orderError) {
    return NextResponse.json({ error: orderError.message }, { status: 500 });
  }

  const { data: job, error: jobError } = await admin
    .from("print_jobs")
    .insert({ order_id: order.id, device_id: device.id })
    .select("id")
    .single();
  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    job_id: job.id,
    note: "Queued. The printer prints it on its next poll - typically within a few seconds.",
  });
}
