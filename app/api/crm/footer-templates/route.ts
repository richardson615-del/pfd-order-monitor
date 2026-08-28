import { NextRequest, NextResponse } from "next/server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { TEMPLATE_CATALOG, ENABLED_TEMPLATES } from "@/lib/footer-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/footer-templates
 *
 * The catalogue the console's template picker is built from, served rather
 * than hardcoded on the CRM side. The bridge client has already drifted out
 * of step with this app once by encoding an assumed shape; a template added
 * here should appear in the picker without a second edit in another repo.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  return NextResponse.json({
    enabled: ENABLED_TEMPLATES,
    templates: TEMPLATE_CATALOG,
  });
}
