import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { composeTicketEmail, sendTicketEmail, SENDER_ADDRESS } from "@/lib/email-out";
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
    .select("id, name, print_method, ticket_email_to, ticket_footer_text, ticket_footer_url, ticket_text_scale")
    .eq("id", params.id)
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

  const email = composeTicketEmail(
    { ...SAMPLE_ORDER, ticket_restaurant_name: r.name },
    {
      footer: { text: r.ticket_footer_text, url: r.ticket_footer_url },
    }
  );

  const result = await sendTicketEmail(to, email);
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
    message_id: result.messageId,
  });
}
