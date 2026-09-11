import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { deliverToApp } from "@/lib/canonical";

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
 * Deliberately does NOT print. The paper path has its own test, and a test of
 * the tablet that also spat out a ticket would put a fake order on the spike
 * in a working kitchen.
 *
 * Safe to run against a live restaurant: the order is marked source 'test',
 * says plainly on its face that it is not real, and touches nothing the
 * printer reads.
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
    .select("id, name, app_expected")
    .eq("id", params.id)
    .maybeSingle();
  if (!restaurant) {
    return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  }

  // Checked BEFORE writing an order. With no subscription there is nothing to
  // push to, so the test would record a failure and tell whoever is standing
  // at the tablet nothing they could act on. This names the missing step.
  const { count } = await admin
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurant.id);

  if (!count) {
    return NextResponse.json(
      {
        error:
          "no device has notifications enabled for this restaurant - open the dashboard on the tablet and tap \"Enable notifications\", then try again",
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

  if (push.sent === 0) {
    return NextResponse.json(
      {
        ok: false,
        order_id: order.id,
        order_number: order.order_number,
        devices_reached: 0,
        error:
          push.error ??
          `the order was created but reached none of the ${push.subscriptions} registered device(s) - the tablet may be offline, or its notification permission may have been revoked`,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    devices_reached: push.sent,
    app_expected: !!restaurant.app_expected,
    note: "The tablet should be chiming now. Open the order and press Accept to stop it.",
    ...(restaurant.app_expected
      ? {}
      : {
          warning:
            "This restaurant is not marked app_expected, so the alert was sent but not recorded and the health checks are not watching this tablet yet. Turn it on once you have confirmed the tablet chimes.",
        }),
  });
}
