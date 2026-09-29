import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { restaurantRefFilter } from "@/lib/restaurant-ref";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { composeBrandedTicketEmail, markTestResend, sendTicketEmail, SENDER_ADDRESS } from "@/lib/email-out";
import { SAMPLE_ORDER } from "@/lib/ticket-preview";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/crm/restaurants/:id/test-email  { to? }
 *
 * The email equivalent of a test print: renders a sample ticket and sends it,
 * so someone can confirm the AEM rule matches and the format prints correctly
 * before a real order depends on it.
 *
 * `to` overrides the destination, which is how a test reaches a PFD address
 * instead of the restaurant during setup. Without it, the restaurant's own
 * configured inbox is used - and that is a real email to a real kitchen, so
 * the response says plainly which one it went to.
 *
 * `order_id` renders a REAL stored order instead of the sample. A sample
 * proves the transport; a real order proves the thing that actually matters -
 * that this restaurant's own modifiers, comments and totals survive the trip
 * and print correctly under their AEM rule. It must be one of THIS
 * restaurant's orders (another restaurant's customer never reaches this
 * kitchen), and it goes out marked TEST RESEND with [TEST] in the subject
 * (ET3), so the kitchen does not cook it again.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const admin = supabaseAdmin();

  const { data: r } = await admin
    .from("restaurants")
    .select("id, name, print_method, ticket_email_to, ticket_footer_text, ticket_footer_url, ticket_text_scale, ticket_logo_b64, ticket_design_style")
    .or(restaurantRefFilter(params.id) ?? "id.eq.00000000-0000-0000-0000-000000000000")
    .limit(1)
    .maybeSingle();
  if (!r) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  const override = typeof body?.to === "string" ? body.to.trim() : "";
  const to = override || (r.ticket_email_to ?? "").trim();
  if (!to) {
    return NextResponse.json(
      { error: "no destination - set ticket_email_to, or pass `to` for a test address" },
      { status: 400 }
    );
  }

  let source: any = { ...SAMPLE_ORDER, ticket_restaurant_name: r.name };
  let renderedOrder: string | null = null;
  if (typeof body?.order_id === "string" && body.order_id.trim()) {
    const { data: o } = await admin
      .from("orders").select("*").eq("id", body.order_id.trim()).eq("restaurant_id", r.id).maybeSingle();
    if (!o) return NextResponse.json({ error: "order not found for this restaurant" }, { status: 404 });
    source = o;
    renderedOrder = o.order_number ?? o.id;
  }

  const composed = await composeBrandedTicketEmail(source, {
    footer: { text: r.ticket_footer_text, url: r.ticket_footer_url },
    logo: r.ticket_logo_b64 ? Buffer.from(r.ticket_logo_b64, "base64") : null,
    design: { style: r.ticket_design_style },
  });
  const email = renderedOrder === null ? composed : markTestResend(composed);

  const result = await sendTicketEmail(to, email);

  // Logged on BOTH paths. A send leaves no row behind - correct, since a test
  // is not a ticket owed - which means the response is otherwise the only
  // evidence it happened, and a response that never reaches whoever is
  // watching makes the send unverifiable after the fact.
  console.log(
    result.ok ? "test-email SENT" : "test-email FAILED",
    JSON.stringify({
      restaurant: r.name,
      to,
      to_restaurant_inbox: !override,
      subject: email.subject,
      order: renderedOrder ?? "(sample)",
      message_id: result.messageId ?? null,
      error: result.error ?? null,
    })
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error, from: SENDER_ADDRESS, to }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    from: SENDER_ADDRESS,
    to,
    // Said plainly, because "test" and "the restaurant's real inbox" are very
    // different things to have just done.
    sent_to_restaurant: !override && to === (r.ticket_email_to ?? "").trim(),
    subject: email.subject,
    rendered_order: renderedOrder,
    sample: renderedOrder === null,
    message_id: result.messageId,
  });
}

/**
 * GET /api/crm/restaurants/:id/test-email
 *
 * What the CRM's "Send test ticket" picker needs before it sends (ET1): the
 * restaurant's configured inbox, and its latest real order (never a test
 * order) so "Last real order" can be labelled with its number and time.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const { data: r } = await admin
    .from("restaurants")
    .select("id, print_method, ticket_email_to")
    .or(restaurantRefFilter(params.id) ?? "id.eq.00000000-0000-0000-0000-000000000000")
    .limit(1)
    .maybeSingle();
  if (!r) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  const { data: o } = await admin
    .from("orders")
    .select("id, order_number, received_at")
    .eq("restaurant_id", r.id)
    .or("source.is.null,source.neq.test")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    from: SENDER_ADDRESS,
    print_method: r.print_method ?? null,
    ticket_email_to: (r.ticket_email_to ?? "").trim() || null,
    latest_order: o ? { order_id: o.id, order_number: o.order_number, received_at: o.received_at } : null,
  });
}
