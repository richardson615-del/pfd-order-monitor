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
  const status = body?.status;
  if (!["new", "opened", "completed", "printed"].includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const update: Record<string, any> = { status };
  const tsCol = STATUS_TIMESTAMP_COLUMN[status];
  if (tsCol) update[tsCol] = new Date().toISOString();

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
