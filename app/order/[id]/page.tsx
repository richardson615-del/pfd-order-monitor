import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase-server";
import OrderViewer from "@/components/OrderViewer";
import { prepMinutesOf } from "@/lib/countdown";

export const dynamic = "force-dynamic";

/** Statuses on which opening the ticket means nothing any more. */
const SETTLED = new Set(["completed", "cancelled"]);

export default async function OrderDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = supabaseServer();

  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("id", params.id)
    .single();

  if (!order) notFound();

  /**
   * Opening the ticket is a look, not an acceptance.
   *
   * I3 (Nick, 2026-09-17) reverses I2 here: opened_at is stamped the first
   * time somebody opens this order - the office's "has anyone looked"
   * record - but accepted_at is NOT. Accept is its own tap (on the card or
   * on this ticket) and is what stops the chime and starts the countdown.
   * Neither timestamp is ever rewritten: the first look and the first
   * acceptance are the ones that mean something. status 'new' still
   * becomes 'opened', as it always did; a 'printed' order keeps its status
   * - that word belongs to the paper channel.
   */
  if (!SETTLED.has(order.status) && !order.opened_at) {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = { opened_at: now };
    if (order.status === "new") update.status = "opened";
    const { data: updated } = await supabase
      .from("orders")
      .update(update)
      .eq("id", order.id)
      .select()
      .single();
    if (updated) Object.assign(order, updated);
  }

  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("timezone, prep_minutes")
    .eq("id", order.restaurant_id)
    .maybeSingle();

  return (
    <OrderViewer
      order={order}
      timezone={restaurant?.timezone ?? null}
      prepMinutes={prepMinutesOf(restaurant?.prep_minutes)}
    />
  );
}
