import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

const STATUS_TIMESTAMP_COLUMN: Record<string, string> = {
  opened: "opened_at",
  completed: "completed_at",
  printed: "printed_at",
};

/**
 * PATCH /api/orders/:id  { status: "opened" | "completed" | "printed" | "new" }
 * Relies on the caller's Supabase session + RLS, so a restaurant can only
 * update orders that belong to it.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const now = new Date().toISOString();

  // { accepted: true } - somebody at the restaurant has agreed to make this.
  // Its own action rather than another status, because it composes with all
  // of them: an order can be printed and unaccepted, or accepted and not yet
  // completed. See migration 021.
  if (body?.accepted === true) {
    const { data, error } = await supabase
      .from("orders")
      // Only accepted_at. opened_at is stamped by the order page on view and
      // is a different fact - overwriting it here would move the record of
      // when the ticket was first seen to when it was agreed to.
      //
      // The `is null` guard means accepted_at is never rewritten: the first
      // acceptance is the one that means something, and a second tap must not
      // move when the kitchen actually agreed to cook.
      .update({ accepted_at: now })
      .eq("id", params.id)
      .is("accepted_at", null)
      .select()
      .single();

    if (error) {
      // Already accepted: not a failure, just a second tap. Hand back the row
      // as it stands so the screen settles on the truth.
      const { data: current } = await supabase
        .from("orders").select("*").eq("id", params.id).single();
      if (current) return NextResponse.json({ order: current });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ order: data });
  }

  const status = body?.status;
  if (!["new", "opened", "completed", "printed"].includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

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
