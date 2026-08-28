import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_FOOTER_TEXT } from "@/lib/ticket";

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
    .select("id, name")
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
      { error: "send footer_text, footer_url and/or text_scale" },
      { status: 400 }
    );
  }

  const { data, error } = await admin
    .from("restaurants")
    .update(updates)
    .eq("id", restaurant.id)
    .select("id, name, ticket_footer_text, ticket_footer_url, ticket_text_scale")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    restaurant: {
      ...data,
      effective_footer_text: (data.ticket_footer_text ?? "").trim() || DEFAULT_FOOTER_TEXT,
      prints_qr: Boolean(data.ticket_footer_url),
    },
  });
}
