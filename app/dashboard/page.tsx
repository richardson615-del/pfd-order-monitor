import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import OrderDashboard from "@/components/OrderDashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const restaurantIds = await getCurrentUserRestaurantIds();
  if (!restaurantIds.length) {
    return (
      <div className="page">
        <div className="empty-state">
          Your account isn&apos;t linked to a restaurant yet. Ask PFD to add
          you from the admin panel.
        </div>
      </div>
    );
  }

  const restaurantId = restaurantIds[0];

  const { data: orders } = await supabase
    .from("orders")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .order("received_at", { ascending: false })
    .limit(200);

  return (
    <OrderDashboard
      initialOrders={orders || []}
      restaurantId={restaurantId}
    />
  );
}
