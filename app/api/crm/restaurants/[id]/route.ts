import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_FOOTER_TEXT } from "@/lib/ticket";
import { normaliseTicketImage, decodeUpload, ImageMode } from "@/lib/ticket-image";
import { ENABLED_TEMPLATES } from "@/lib/footer-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id  { footer_text?, footer_url? }
 *
 * Either field may be sent as null or "" to clear it, which is a real
 * intention - "stop printing my message" - and must not be confused with
 * "field omitted, leave it alone". So presence in the body decides.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name, print_method, ticket_email_to")
    .eq("id", params.id)
    .maybeSingle();
  if (!restaurant) {
    return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if ("footer_text" in body) {
    const v = typeof body.footer_text === "string" ? body.footer_text.trim() : "";
    updates.ticket_footer_text = v || null;
  }
  if ("footer_url" in body) {
    const v = typeof body.footer_url === "string" ? body.footer_url.trim() : "";
    if (v && !/^https?:\/\//i.test(v)) {
      // A QR encoding "pfdworks.com" scans to nothing useful on most phones.
      return NextResponse.json(
        { error: "footer_url must start with http:// or https://" },
        { status: 400 }
      );
    }
    updates.ticket_footer_url = v || null;
  }
  if ("print_method" in body) {
    const v = String(body.print_method ?? "");
    if (v !== "printer" && v !== "email") {
      return NextResponse.json(
        { error: "print_method must be 'printer' or 'email'" },
        { status: 400 }
      );
    }
    // Switching to email without an address would silently stop every ticket
    // reaching this restaurant - refuse rather than accept a config that
    // cannot work.
    const addr =
      "ticket_email_to" in body
        ? String(body.ticket_email_to ?? "").trim()
        : String(restaurant.ticket_email_to ?? "").trim();
    if (v === "email" && !addr) {
      return NextResponse.json(
        { error: "ticket_email_to is required before print_method can be 'email'" },
        { status: 400 }
      );
    }
    updates.print_method = v;
  }

  if ("ticket_email_to" in body) {
    const v = String(body.ticket_email_to ?? "").trim();
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      return NextResponse.json(
        { error: "ticket_email_to must be a valid email address" },
        { status: 400 }
      );
    }
    updates.ticket_email_to = v || null;
  }

  if ("footer_engine" in body) {
    const v = String(body.footer_engine ?? "");
    if (v !== "static" && v !== "dynamic") {
      return NextResponse.json(
        { error: "footer_engine must be 'static' or 'dynamic'" },
        { status: 400 }
      );
    }
    updates.footer_engine = v;
  }

  if ("footer_template_id" in body) {
    const v = body.footer_template_id === null ? null : String(body.footer_template_id ?? "");
    if (v !== null && !ENABLED_TEMPLATES.includes(v as any)) {
      // Milestone and mystery templates exist in the engine but are refused
      // here: prize promotions carry registration and disclosure duties that
      // vary by state, and none of that has been reviewed yet.
      return NextResponse.json(
        {
          error: `footer_template_id must be one of: ${ENABLED_TEMPLATES.join(", ")}`,
          note: "prize-based templates are disabled pending promotional-rules review",
        },
        { status: 400 }
      );
    }
    updates.footer_template_id = v;
  }

  if ("footer_template_config" in body) {
    const v = body.footer_template_config;
    if (v === null) updates.footer_template_config = {};
    else if (typeof v !== "object" || Array.isArray(v)) {
      return NextResponse.json(
        { error: "footer_template_config must be a JSON object" },
        { status: 400 }
      );
    } else updates.footer_template_config = v;
  }

  if ("design_style" in body) {
    const v = String(body.design_style ?? "");
    if (!["classic", "bold", "editorial"].includes(v)) {
      return NextResponse.json(
        { error: "design_style must be 'classic', 'bold' or 'editorial'" },
        { status: 400 }
      );
    }
    updates.ticket_design_style = v;
  }

  if ("footer_mode" in body) {
    const v = String(body.footer_mode ?? "");
    if (!["qr_with_text", "text_only", "image"].includes(v)) {
      return NextResponse.json(
        { error: "footer_mode must be 'qr_with_text', 'text_only' or 'image'" },
        { status: 400 }
      );
    }
    updates.ticket_footer_mode = v;
  }

  // Images: converted here, once, so the print path never does image work.
  const imageMode = (typeof body.image_mode === "string" ? body.image_mode : "auto") as ImageMode;
  const conversions: Record<string, unknown> = {};
  for (const [field, column] of [
    ["logo_image", "ticket_logo_b64"],
    ["footer_image", "ticket_footer_image_b64"],
  ] as const) {
    if (!(field in body)) continue;
    if (body[field] === null || body[field] === "") {
      updates[column] = null;            // clearing is a real intention
      conversions[field] = "cleared";
      continue;
    }
    const { buffer, error } = decodeUpload(body[field]);
    if (error) return NextResponse.json({ error: `${field}: ${error}` }, { status: 400 });
    try {
      const out = await normaliseTicketImage(buffer!, imageMode);
      updates[column] = out.base64;
      conversions[field] = {
        width: out.width, height: out.height, mode: out.mode, reason: out.reason,
        stored_bytes: Buffer.from(out.base64, "base64").length,
      };
    } catch (err) {
      return NextResponse.json(
        { error: `${field}: could not decode image (${err instanceof Error ? err.message : "unknown"})` },
        { status: 400 }
      );
    }
  }

  if ("text_scale" in body) {
    const v = String(body.text_scale ?? "");
    if (v !== "normal" && v !== "large") {
      return NextResponse.json(
        { error: "text_scale must be 'normal' or 'large'" },
        { status: 400 }
      );
    }
    updates.ticket_text_scale = v;
  }
  if (!Object.keys(updates).length) {
    return NextResponse.json(
      { error: "send at least one of: footer_text, footer_url, footer_mode, footer_engine, footer_template_id, footer_template_config, text_scale, design_style, logo_image, footer_image, print_method, ticket_email_to" },
      { status: 400 }
    );
  }

  const { data, error } = await admin
    .from("restaurants")
    .update(updates)
    .eq("id", restaurant.id)
    .select("id, name, ticket_footer_text, ticket_footer_url, ticket_text_scale, ticket_design_style, ticket_footer_mode, footer_engine, footer_template_id, footer_template_config, print_method, ticket_email_to")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    // What the server did to each upload, so the console can explain the
    // result rather than just showing it.
    ...(Object.keys(conversions).length ? { conversions } : {}),
    restaurant: {
      ...data,
      effective_footer_text: (data.ticket_footer_text ?? "").trim() || DEFAULT_FOOTER_TEXT,
      prints_qr: data.ticket_footer_mode === "qr_with_text" && Boolean(data.ticket_footer_url),
    },
  });
}
