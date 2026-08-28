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
    .select("id, name, is_active, zuppler_restaurant_id, crm_restaurant_id, ticket_footer_text, ticket_footer_url, ticket_text_scale, ticket_design_style, ticket_footer_mode, ticket_logo_b64, ticket_footer_image_b64, footer_engine, footer_template_id, footer_template_config, order_counter")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    // So the console can show what will actually print, rather than an empty
    // box that silently becomes the PFD line at print time.
    default_footer_text: DEFAULT_FOOTER_TEXT,
    restaurants: (data ?? []).map((r: any) => {
      // Images are returned as presence + size, never inline. A roster call
      // that shipped every logo would be megabytes for a list view, and the
      // console only needs to know whether one is set.
      const { ticket_logo_b64, ticket_footer_image_b64, ...rest } = r;
      return {
        ...rest,
        has_logo: Boolean(ticket_logo_b64),
        logo_bytes: ticket_logo_b64 ? Buffer.from(ticket_logo_b64, "base64").length : 0,
        has_footer_image: Boolean(ticket_footer_image_b64),
        effective_footer_text: (r.ticket_footer_text ?? "").trim() || DEFAULT_FOOTER_TEXT,
        prints_qr: r.ticket_footer_mode === "qr_with_text" && Boolean(r.ticket_footer_url),
      };
    }),
  });
}
