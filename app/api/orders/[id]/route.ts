import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { prepMinutesOf } from "@/lib/countdown";
import { parseOrderPatch, readyByFor, refuseReadyChange } from "@/lib/ready-timer";
import { isScheduled } from "@/lib/order-display";

const STATUS_TIMESTAMP_COLUMN: Record<string, string> = {
  opened: "opened_at",
  completed: "completed_at",
  printed: "printed_at",
};

/**
 * PATCH /api/orders/:id, one action per call (lib/ready-timer.ts):
 *   { accepted: true, minutes? }  accept; minutes (1-180) default to the restaurant's prep target.
 *                                 A scheduled order (due > 2 h out, SC1) takes no minutes: ready_by = due_time.
 *   { ready: true }               the food is ready (PA5); stamps ready_at once
 *   { minutes }                   re-time an accepted, not-ready order (minutes from Accept)
 *   { status: "opened" | "completed" | "printed" | "new" }
 * Relies on the caller's Supabase session (cookie on the tablet, Bearer from
 * the PFD Partner app) + RLS, so a restaurant can only update its own orders.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = parseOrderPatch(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const patch = parsed.patch;
  const now = new Date().toISOString();

  const current = async () => (await supabase.from("orders").select("*").eq("id", params.id).single()).data;

  // { accepted: true } - somebody at the restaurant has agreed to make this.
  // Its own action rather than another status, because it composes with all
  // of them: an order can be printed and unaccepted, or accepted and not yet
  // completed. See migration 021. PA5: it now says for how long.
  if (patch.kind === "accept") {
    const order = await current();
    if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });
    let minutes: number | null = patch.minutes;
    let readyBy: string | null;
    if (isScheduled(order, Date.now())) {
      // SC1: a catering order accepted a day early is acknowledged, not
      // started. Its ready time is the hand-off itself; no minutes are
      // chosen (the card offers none), and the countdown appears two hours
      // before it is due (lib/countdown.ts).
      minutes = null;
      readyBy = new Date(order.due_time).toISOString();
    } else {
      if (minutes === null) {
        const { data: r } = await supabase.from("restaurants").select("prep_minutes").eq("id", order.restaurant_id).maybeSingle();
        minutes = prepMinutesOf(r?.prep_minutes);
      }
      readyBy = readyByFor(now, minutes);
    }
    const { data, error } = await supabase
      .from("orders")
      // Only accepted_at (and the PA5 timer). opened_at is stamped by the
      // order page on view and is a different fact - overwriting it here
      // would move the record of when the ticket was first seen to when it
      // was agreed to.
      //
      // The `is null` guard means accepted_at is never rewritten: the first
      // acceptance is the one that means something, and a second tap must not
      // move when the kitchen actually agreed to cook.
      .update({ accepted_at: now, ready_minutes: minutes, ready_by: readyBy })
      .eq("id", params.id)
      .is("accepted_at", null)
      .select()
      .single();

    if (error) {
      // Already accepted: not a failure, just a second tap. Hand back the row
      // as it stands so the screen settles on the truth.
      const order = await current();
      if (order) return NextResponse.json({ order });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ order: data });
  }

  // { ready: true } - the food is on the pass (PA5). Stamped once; a second
  // tap hands back the row. An order nobody accepted is accepted by it too
  // (the chime has nothing left to ask for).
  if (patch.kind === "ready") {
    const order = await current();
    if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });
    if (order.ready_at) return NextResponse.json({ order });
    const refused = refuseReadyChange(order, "ready");
    if (refused) return NextResponse.json(refused, { status: 409 });
    const update: Record<string, unknown> = { ready_at: now };
    if (!order.accepted_at) update.accepted_at = now;
    const { data, error } = await supabase.from("orders").update(update).eq("id", params.id).is("ready_at", null).select().single();
    if (error) {
      const again = await current();
      if (again) return NextResponse.json({ order: again });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ order: data });
  }

  // { minutes } - the kitchen is running late (or early): ready_by moves to
  // accepted_at + minutes. accepted_at itself never moves.
  if (patch.kind === "retime") {
    const order = await current();
    if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });
    const refused = refuseReadyChange(order, "retime");
    if (refused) return NextResponse.json(refused, { status: 409 });
    const { data, error } = await supabase
      .from("orders")
      .update({ ready_minutes: patch.minutes, ready_by: readyByFor(order.accepted_at, patch.minutes) })
      .eq("id", params.id)
      .is("ready_at", null)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ order: data });
  }

  const status = patch.status;
  const update: Record<string, any> = { status };
  const tsCol = STATUS_TIMESTAMP_COLUMN[status];
  if (tsCol) update[tsCol] = now;

  const { data, error } = await supabase
    .from("orders")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ order: data });
}
