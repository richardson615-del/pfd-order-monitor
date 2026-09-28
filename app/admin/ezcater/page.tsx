import { redirect } from "next/navigation";
import { isCurrentUserAdmin } from "@/lib/authz";
import EzCaterAdmin from "@/components/EzCaterAdmin";

export const dynamic = "force-dynamic";

/** ezCater Phase 2 setup and watch page (Matt, 2026-09-28). Admins only. */
export default async function EzCaterAdminPage() {
  if (!(await isCurrentUserAdmin())) redirect("/login?next=/admin/ezcater");
  return <EzCaterAdmin />;
}
