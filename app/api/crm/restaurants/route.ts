import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_FOOTER_TEXT } from "@/lib/ticket";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/restaurants - the roster, with what each one prints on its
 * ticket footer. Restaurant-level rather than device-level: the footer belongs
 * to the business, not to a particular printer, and moving a printer must not
 * move the message.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("restaurants")
    .select("id, name, is_active, zuppler_restaurant_id, crm_restaurant_id, ticket_footer_text, ticket_footer_url")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    // So the console can show what will actually print, rather than an empty
    // box that silently becomes the PFD line at print time.
    default_footer_text: DEFAULT_FOOTER_TEXT,
    restaurants: (data ?? []).map((r: any) => ({
      ...r,
      effective_footer_text: (r.ticket_footer_text ?? "").trim() || DEFAULT_FOOTER_TEXT,
      prints_qr: Boolean(r.ticket_footer_url),
    })),
  });
}
