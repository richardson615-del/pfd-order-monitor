import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { queueOrderToPrinters } from "@/lib/print-queue";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/:id/print
 *
 * Sends this order to the restaurant's own thermal printer, now, on request.
 *
 * The tablet already had a "Print" button and it called window.print() — the
 * BROWSER's print dialog. On a kiosk tablet that reaches nothing: the Epson
 * is not a system printer, it polls us over Server Direct Print and prints
 * what we hand back. So the one device in the building that can make a ticket
 * was the one thing that button could not talk to.
 *
 * Reprinting matters more than it sounds. A ticket gets lost, a printer is
 * out of paper when the order lands, somebody needs a second copy for the
 * driver — and the alternative today is telephoning PFD to do it from the
 * CRM.
 *
 * Authorisation is the ordinary one for this app and the important part is
 * which client does what: the ORDER is read through the caller's own session,
 * so RLS confines them to their own restaurant's orders and an id belonging
 * to somebody else simply is not found. Only then does the service-role
 * client queue the job — restaurant sessions cannot write print_jobs, and
 * they should not be able to.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Through the user's client on purpose. RLS is the authorisation check
  // here; doing this read as admin and then filtering by hand is how a
  // cross-restaurant reprint gets shipped by accident.
  const { data: order } = await supabase
    .from("orders")
    .select("id, restaurant_id, order_number")
    .eq("id", params.id)
    .maybeSingle();

  if (!order) {
    // Not found and not yours are deliberately one answer: the WHERE clause
    // is the permission check, so distinguishing them would leak which order
    // ids exist.
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  const result = await queueOrderToPrinters(order.id, order.restaurant_id);

  if (result.refusal) {
    return NextResponse.json(
      { error: result.message, code: result.refusal },
      // email_restaurant and no_active_printer are both "correct request,
      // nothing here can do it" rather than a malformed one.
      { status: result.refusal === "restaurant_not_found" ? 404 : 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    order_number: order.order_number,
    queued: result.queued.length,
    devices: result.queued.map((q) => q.deviceName),
    // Queued, not printed. The printer claims it on its next poll, and
    // telling somebody it printed sends them to look at a printer that has
    // not moved yet.
    note: "Queued. It prints on the printer's next poll - usually a few seconds.",
  });
}
