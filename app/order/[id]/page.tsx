import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase-server";
import OrderViewer from "@/components/OrderViewer";

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
   * Opening the ticket is the acknowledgement.
   *
   * There is no Accept step (Nick, 2026-09-16): the first time somebody
   * opens this order, opened_at is stamped - which stops the chime - and
   * accepted_at with it ("when the ticket is opened treat that as
   * accepted"), so the office's "nobody has looked at this order" alarm
   * keeps its meaning and orders accepted under the old button read the
   * same as ones opened under this. Neither is ever rewritten: the first
   * look is the one that means something. status 'new' still becomes
   * 'opened', as it always did; a 'printed' order keeps its status - that
   * word belongs to the paper channel.
   */
  if (!SETTLED.has(order.status) && (!order.opened_at || !order.accepted_at)) {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {};
    if (!order.opened_at) update.opened_at = now;
    if (!order.accepted_at) update.accepted_at = now;
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
    .select("timezone")
    .eq("id", order.restaurant_id)
    .maybeSingle();

  return <OrderViewer order={order} timezone={restaurant?.timezone ?? null} />;
}
