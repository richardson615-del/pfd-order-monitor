import { supabaseAdmin } from "./supabase-server";
import { deliverToApp } from "./canonical";
import { queueOrderToPrinters } from "./print-queue";

/**
 * A test order to a restaurant's tablet AND printer, as one function.
 *
 * Two callers, one rule. The CRM presses it from the office
 * (POST /api/crm/restaurants/:id/test-order); the tablet presses it from
 * its own Ready screen on first run (POST /api/dashboard/test-order, "Send
 * me a test order") - the moment somebody is standing in front of the
 * equipment wanting to know both halves work. A second copy of this in the
 * second route is how the two would drift.
 *
 * It PRINTS as well as chimes, since 2026-09-14 (Nick): "when i press test
 * order it should send to both the printer and tablet". That reversed a
 * deliberate decision, so the old reasoning is kept rather than deleted: it
 * used to print nothing, because a test of the tablet that also spat out a
 * ticket would put a fake order on the spike in a working kitchen. What that
 * missed is when this is actually pressed - during setup, in front of the
 * equipment. A restaurant receives orders on paper and on a screen; a test
 * that proves one leaves you to discover the other the first time it
 * matters.
 *
 * The ticket says what it is in three places (a TEST- order number, the item
 * name, and the note), so the piece of paper cannot be mistaken for food to
 * cook. Safe to run against a live restaurant: source 'test'.
 */

export interface TestOrderOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function sendTestOrder(restaurantId: string): Promise<TestOrderOutcome> {
  const admin = supabaseAdmin();
  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name, app_expected, print_method")
    .eq("id", restaurantId)
    .maybeSingle();
  if (!restaurant) return { status: 404, body: { error: "restaurant not found" } };

  // Checked BEFORE writing an order, and against BOTH destinations.
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
    return {
      status: 409,
      body: {
        error:
          "this restaurant has nowhere to receive a test order - no device has notifications enabled, and there is no active printer. Open the app on the tablet and tap \"Turn on alerts\", or register a printer, then try again",
        devices: 0,
      },
    };
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
      customer_name: "Premium test order",
      items: [
        { name: "2x Test item", price: "$0.00", modifiers: ["This is a test", "Do not make"] },
      ],
      items_total: 0,
      customer_total: 0,
      notes: "Test order sent to check this tablet. Not a real order - do not make it.",
      status: "new",
    })
    .select("id, order_number")
    .single();

  if (orderError) return { status: 500, body: { error: orderError.message } };

  // Paper first: it is the destination that cannot report itself. A push
  // tells us how many devices it reached; a queued job only tells us it was
  // queued, so the sooner it is in front of the printer the sooner somebody
  // standing there sees it.
  const paper = await queueOrderToPrinters(order.id, restaurant.id, { queuedBy: "test" });

  const push = await deliverToApp({
    orderId: order.id,
    restaurantId: restaurant.id,
    // Honest either way: a restaurant not yet marked app_expected still gets
    // the alert, it just does not earn a delivery row. That order matters -
    // turning app_expected on before the tablet can receive anything makes
    // every subsequent order raise a critical alert.
    appExpected: !!restaurant.app_expected,
    orderNumber: order.order_number,
    customerName: "Premium test order",
    customerTotal: 0,
  });

  // A tablet that was reached by nothing is still a failure - but only if
  // the printer did not get it either. Reporting a successful print as a 502
  // because a restaurant has no tablet yet would make the printer test
  // unusable at exactly the sites being set up.
  if (push.sent === 0 && paper.queued.length === 0) {
    return {
      status: 502,
      body: {
        ok: false,
        order_id: order.id,
        order_number: order.order_number,
        devices_reached: 0,
        printers_queued: 0,
        error:
          push.error ??
          `the order was created but reached none of the ${push.subscriptions} registered device(s), and ${paper.message ?? "no printer took it"}`,
      },
    };
  }

  const reached = [
    push.sent > 0 ? `${push.sent} tablet${push.sent === 1 ? "" : "s"}` : null,
    paper.queued.length > 0
      ? `${paper.queued.length} printer${paper.queued.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return {
    status: 200,
    body: {
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
        (push.sent > 0 ? " The tablet should be chiming now - open the order to stop it." : "") +
        (paper.queued.length > 0 ? " The ticket prints on the printer's next poll." : ""),
      ...(restaurant.app_expected
        ? {}
        : {
            warning:
              "This restaurant is not marked app_expected, so the alert was sent but not recorded and the health checks are not watching this tablet yet. Turn it on once you have confirmed the tablet chimes.",
          }),
    },
  };
}
