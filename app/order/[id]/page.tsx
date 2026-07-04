import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase";
import OrderViewer from "@/components/OrderViewer";

export const dynamic = "force-dynamic";

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

  // Mark as opened the first time someone views it (stops the sound alert loop)
  if (order.status === "new") {
    const { data: updated } = await supabase
      .from("orders")
      .update({ status: "opened", opened_at: new Date().toISOString() })
      .eq("id", order.id)
      .select()
      .single();
    if (updated) Object.assign(order, updated);
  }

  return <OrderViewer order={order} />;
}
