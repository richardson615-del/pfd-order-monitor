import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_FOOTER_TEXT } from "@/lib/ticket";
import { orderDestinations } from "@/lib/canonical";

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
    .select("id, name, is_active, zuppler_restaurant_id, crm_restaurant_id, ticket_footer_text, ticket_footer_url, ticket_text_scale, ticket_design_style, ticket_footer_mode, ticket_logo_b64, ticket_footer_image_b64, footer_engine, footer_template_id, footer_template_config, order_counter, print_method, ticket_email_to, app_expected")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Who actually has a working printer. Asked once for the whole roster
  // rather than per restaurant, and asked of print_devices rather than of
  // printer_expected - see orderDestinations() for why that flag cannot
  // answer this.
  const { data: deviceRows } = await admin
    .from("print_devices")
    .select("restaurant_id")
    .eq("is_active", true);
  const withPrinter = new Set((deviceRows ?? []).map((d: any) => d.restaurant_id));

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
        // Surfaced so the console can show a misconfiguration before an order
        // arrives, rather than after a ticket fails to reach anyone.
        email_delivery_ready:
          r.print_method !== "email" || Boolean((r.ticket_email_to ?? "").trim()),
        has_active_printer: withPrinter.has(r.id),
        // The straight answer to "where do this restaurant's orders go?".
        // Computed here so the console never has to re-derive it from three
        // columns and get a different answer than the ingest does. An empty
        // list means orders arrive and nobody there is told.
        destinations: orderDestinations({
          print_method: r.print_method,
          app_expected: r.app_expected,
          hasActivePrinter: withPrinter.has(r.id),
        }),
      };
    }),
  });
}
