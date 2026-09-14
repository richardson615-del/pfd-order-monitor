import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { deliverToApp } from "@/lib/canonical";
import { queueOrderToPrinters } from "@/lib/print-queue";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id/test-order
 *
 * Sends a test order to the restaurant's TABLET. The screen lights up, chimes,
 * and the order can be opened and accepted like any other - which is the only
 * way to know the tablet actually works before a customer finds out it does
 * not.
 *
 * This existed for every other destination and not this one. A printer has
 * test_print, an AEM restaurant has test-email, and the tablet had nothing -
 * so proving a newly installed tablet worked meant waiting for a real order,
 * on a real restaurant, during real service. That is the wrong moment to
 * discover that nobody tapped "Enable notifications".
 *
 * It PRINTS as well, since 2026-09-14 (Nick): "when i press test order it
 * should send to both the printer and tablet".
 *
 * This reverses a deliberate decision, so the old reasoning is worth keeping
 * rather than quietly deleting: it used to print nothing, because a test of
 * the tablet that also spat out a ticket would put a fake order on the spike
 * in a working kitchen. What that missed is when this button is actually
 * pressed — during setup, standing in front of the equipment, wanting to know
 * that BOTH destinations work. A restaurant receives orders on paper and on a
 * screen; a test that only proves one of them leaves you to discover the
 * other the first time it matters.
 *
 * The ticket says what it is in three places (a TEST- order number, the item
 * name, and the note), so the piece of paper cannot be mistaken for food to
 * cook.
 *
 * Safe to run against a live restaurant: the order is marked source 'test'
 * and says plainly on its face that it is not real.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name, app_expected, print_method")
    .eq("id", params.id)
    .maybeSingle();
  if (!restaurant) {
    return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  }

  // Checked BEFORE writing an order, and now against BOTH destinations.
  //
  // The refusal used to be "no push subscription", which was right when the
  // tablet was the only thing this could reach. Now that it prints too, that
  // test would block the printer half at every restaurant whose tablet is not
  // set up yet - which is most of them, and exactly the ones being set up.
  //
  // So it refuses only when there is nowhere at all for the order to go. The
  // missing step is still named, because "no subscription" is the answer
  // somebody standing at a mute tablet needs.
  const { count } = await admin
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurant.id);

  const { count: printerCount } = await admin
    .from("print_devices")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurant.id)
    .eq("is_active", true);

  const canPrint = restaurant.print_method !== "email" && Boolean(printerCount);

  if (!count && !canPrint) {
    return NextResponse.json(
      {
        error:
          "this restaurant has nowhere to receive a test order - no device has notifications enabled, and there is no active printer. Open the dashboard on the tablet and tap \"Enable notifications\", or register a printer, then try again",
        devices: 0,
      },
      { status: 409 }
    );
  }

  const stamp = new Date();
  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      source: "test",
      external_id: `crm-test-order:${restaurant.id}:${stamp.getTime()}`,
      restaurant_id: restaurant.id,
      order_number: `TEST-${stamp.getTime().toString(36).toUpperCase().slice(-6)}`,
      ticket_restaurant_name: restaurant.name,
      order_type: "pickup",
      // Everything a cook would check, so the test proves the SCREEN rather
      // than proving a notification arrived: a quantity, a modifier, a note.
      customer_name: "PFD test order",
      items: [
        { name: "2x Test item", price: "$0.00", modifiers: ["This is a test", "Do not make"] },
      ],
      items_total: 0,
      customer_total: 0,
      notes: "Test order sent from the CRM to check this tablet. Not a real order - do not make it.",
      status: "new",
    })
    .select("id, order_number")
    .single();

  if (orderError) {
    return NextResponse.json({ error: orderError.message }, { status: 500 });
  }

  // Paper first: it is the destination that cannot report itself. A push
  // tells us how many devices it reached; a queued job only tells us it was
  // queued, so the sooner it is in front of the printer the sooner somebody
  // standing there sees it.
  const paper = await queueOrderToPrinters(order.id, restaurant.id);

  const push = await deliverToApp({
    orderId: order.id,
    restaurantId: restaurant.id,
    // Honest either way: a restaurant not yet marked app_expected still gets
    // the alert, it just does not earn a delivery row. That order matters -
    // turning app_expected on before the tablet can receive anything makes
    // every subsequent order raise a critical alert.
    appExpected: !!restaurant.app_expected,
    orderNumber: order.order_number,
    customerName: "PFD test order",
    customerTotal: 0,
  });

  // A tablet that was reached by nothing is still a failure - but only if
  // the printer did not get it either. Reporting a successful print as a 502
  // because a restaurant has no tablet yet would make the printer test
  // unusable at exactly the sites being set up.
  if (push.sent === 0 && paper.queued.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        order_id: order.id,
        order_number: order.order_number,
        devices_reached: 0,
        printers_queued: 0,
        error:
          push.error ??
          `the order was created but reached none of the ${push.subscriptions} registered device(s), and ${paper.message ?? "no printer took it"}`,
      },
      { status: 502 }
    );
  }

  const reached = [
    push.sent > 0 ? `${push.sent} tablet${push.sent === 1 ? "" : "s"}` : null,
    paper.queued.length > 0
      ? `${paper.queued.length} printer${paper.queued.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return NextResponse.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    devices_reached: push.sent,
    printers_queued: paper.queued.length,
    printers: paper.queued.map((q) => q.deviceName),
    // Why paper did NOT go out, when it did not. Silence here is how an
    // email restaurant looks identical to a broken printer.
    ...(paper.refusal ? { print_note: paper.message } : {}),
    app_expected: !!restaurant.app_expected,
    note:
      `Sent to ${reached.join(" and ")}.` +
      (push.sent > 0
        ? " The tablet should be chiming now - open the order and press Accept to stop it."
        : "") +
      (paper.queued.length > 0 ? " The ticket prints on the printer's next poll." : ""),
    ...(restaurant.app_expected
      ? {}
      : {
          warning:
            "This restaurant is not marked app_expected, so the alert was sent but not recorded and the health checks are not watching this tablet yet. Turn it on once you have confirmed the tablet chimes.",
        }),
  });
}
