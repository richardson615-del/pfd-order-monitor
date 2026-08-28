import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { renderTicketPreview, SAMPLE_ORDER } from "@/lib/ticket-preview";
import { normaliseTicketImage, decodeUpload, ImageMode } from "@/lib/ticket-image";
import type { FooterMode } from "@/lib/ticket-raster";
import type { TextScale } from "@/lib/ticket";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/crm/restaurants/:id/ticket-preview -> image/png
 *
 * Renders a sample ticket with the restaurant's SAVED branding, or with
 * proposed branding sent in the body. Nothing is written, so the console can
 * show what will print while someone is still deciding.
 *
 * The preview is produced by the same header and footer renderer the printer
 * receives, so it cannot drift from reality - which matters, because a
 * preview people trust and that quietly lies is worse than no preview.
 *
 * Body (all optional; each overrides the saved value):
 *   design_style, footer_mode, footer_text, footer_url, text_scale,
 *   logo_image, footer_image (base64 or data: URL), image_mode,
 *   order_type ("pickup" | "delivery")
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = (await req.json().catch(() => ({}))) ?? {};

  const admin = supabaseAdmin();
  const { data: r } = await admin
    .from("restaurants")
    .select("id, name, ticket_design_style, ticket_footer_mode, ticket_footer_text, ticket_footer_url, ticket_text_scale, ticket_logo_b64, ticket_footer_image_b64")
    .eq("id", params.id)
    .maybeSingle();
  if (!r) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  const pick = <T>(key: string, saved: T): T =>
    key in body ? (body[key] as T) : saved;

  // A proposed image arrives raw and is converted here exactly as it would be
  // on save - otherwise the preview would show a different image to the one
  // that ends up printing.
  const imageMode = (typeof body.image_mode === "string" ? body.image_mode : "auto") as ImageMode;
  async function resolveImage(field: string, savedB64: string | null): Promise<Buffer | null> {
    if (!(field in body)) return savedB64 ? Buffer.from(savedB64, "base64") : null;
    if (body[field] === null || body[field] === "") return null;
    const { buffer, error } = decodeUpload(body[field]);
    if (error || !buffer) throw new Error(`${field}: ${error ?? "undecodable"}`);
    const out = await normaliseTicketImage(buffer, imageMode);
    return Buffer.from(out.base64, "base64");
  }

  let logo: Buffer | null = null;
  let footerImage: Buffer | null = null;
  try {
    logo = await resolveImage("logo_image", r.ticket_logo_b64);
    footerImage = await resolveImage("footer_image", r.ticket_footer_image_b64);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "image could not be processed" },
      { status: 400 }
    );
  }

  const orderType = body.order_type === "delivery" ? "delivery" : "pickup";
  const order = {
    ...SAMPLE_ORDER,
    ticket_restaurant_name: r.name,
    order_type: orderType,
    ...(orderType === "delivery"
      ? { customer_address: "4445 Mount Zion Road, Springfield, TN 37172 | Ring the bell" }
      : {}),
  };

  try {
    const png = await renderTicketPreview({
      order,
      design: { style: pick("design_style", r.ticket_design_style) as any },
      scale: pick("text_scale", r.ticket_text_scale) as TextScale,
      footerMode: pick("footer_mode", r.ticket_footer_mode) as FooterMode,
      footerText: pick("footer_text", r.ticket_footer_text),
      footerUrl: pick("footer_url", r.ticket_footer_url),
      logo,
      footerImage,
    });
    // Buffer -> Uint8Array: NextResponse types the body as BodyInit, which
    // Node's Buffer does not satisfy even though it works at runtime.
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        // Never cached: the whole point is reflecting unsaved edits.
        "Cache-Control": "no-store",
        "X-Ticket-Width": "576",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `preview failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 }
    );
  }
}
