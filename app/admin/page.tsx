import { redirect } from "next/navigation";
import { isCurrentUserAdmin } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/supabase";
import AdminPanel from "@/components/AdminPanel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const ok = await isCurrentUserAdmin();
  if (!ok) redirect("/login?next=/admin");

  const admin = supabaseAdmin();
  const { data: restaurants } = await admin
    .from("restaurants")
    .select("*, monitored_inboxes(*)")
    .order("created_at", { ascending: false });

  return <AdminPanel initialRestaurants={restaurants || []} />;
}
