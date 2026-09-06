import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { sendComposedEmail, htmlToPlainText, SENDER_ADDRESS } from "@/lib/email-out";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/crm/send-statement
 *
 * Sends a restaurant payout statement as email from the PFD identity, using
 * the same gmail.send grant that sends order tickets - so an owner sees the
 * address they already recognise.
 *
 * The bridge is a send mechanism and nothing more: no templating, no payout
 * maths, no PDF. The CRM composes the subject and the HTML and this sends
 * them verbatim. That division matters - two systems computing the same
 * payout is how two systems disagree about someone's money.
 *
 * A statement is not a ticket, and two things follow:
 *
 *   - It is idempotent on `idempotency_key`. A duplicate ticket is a
 *     confusing second piece of paper; two statements about the same money
 *     leave an owner unable to tell which is current.
 *   - Every attempt is recorded. "Which figures went to whom, and when" is
 *     the question asked when a payout is disputed.
 */

const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
  }

  const to = String(body.to ?? "").trim();
  const subject = String(body.subject ?? "").trim();
  const html = typeof body.html === "string" ? body.html : "";

  if (!to || !isEmail(to)) {
    return NextResponse.json({ error: "`to` must be a valid email address" }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ error: "`subject` is required" }, { status: 400 });
  }
  if (!html.trim()) {
    return NextResponse.json({ error: "`html` is required and must not be empty" }, { status: 400 });
  }
  // A statement large enough to hit Gmail's message limit would fail opaquely
  // at the API; refusing here says why.
  if (Buffer.byteLength(html, "utf8") > 5_000_000) {
    return NextResponse.json(
      { error: "`html` exceeds 5MB - Gmail will reject the message" },
      { status: 400 }
    );
  }

  const idempotencyKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim().slice(0, 200)
      : null;
  const dryRun = body.dry_run === true;

  const admin = supabaseAdmin();

  // Idempotency check BEFORE sending. A retry after a timeout must not send a
  // second statement - the first may well have arrived.
  if (idempotencyKey && !dryRun) {
    const { data: prior } = await admin
      .from("statement_sends")
      .select("id, message_id, to_address, created_at, status")
      .eq("idempotency_key", idempotencyKey)
      .eq("status", "sent")
      .maybeSingle();
    if (prior) {
      return NextResponse.json({
        ok: true,
        deduped: true,
        message_id: prior.message_id,
        to: prior.to_address,
        sent_to_restaurant: true,
        note: `Already sent at ${prior.created_at}. No second email was sent.`,
      });
    }
  }

  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text
      : htmlToPlainText(html);

  const audit = {
    idempotency_key: idempotencyKey,
    to_address: to,
    subject,
    restaurant_id:
      typeof body.restaurant_id === "string" && body.restaurant_id.trim()
        ? body.restaurant_id.trim()
        : null,
    restaurant_name:
      typeof body.restaurant_name === "string" ? body.restaurant_name.slice(0, 200) : null,
    period_start: typeof body.period_start === "string" ? body.period_start : null,
    period_end: typeof body.period_end === "string" ? body.period_end : null,
    html_bytes: Buffer.byteLength(html, "utf8"),
  };

  // Dry run: everything except the send. Lets a human confirm the destination
  // and the subject before a real owner receives financial figures.
  if (dryRun) {
    await admin.from("statement_sends").insert({ ...audit, status: "dry_run" });
    return NextResponse.json({
      ok: true,
      dry_run: true,
      sent: false,
      from: SENDER_ADDRESS,
      to,
      subject,
      html_bytes: audit.html_bytes,
      text_preview: text.slice(0, 500),
      sent_to_restaurant: false,
    });
  }

  const result = await sendComposedEmail(to, { subject, text, html });

  console.log(
    result.ok ? "send-statement SENT" : "send-statement FAILED",
    JSON.stringify({
      to,
      subject,
      restaurant: audit.restaurant_name,
      period: [audit.period_start, audit.period_end],
      message_id: result.messageId ?? null,
      error: result.error ?? null,
    })
  );

  const { error: auditError } = await admin.from("statement_sends").insert({
    ...audit,
    message_id: result.messageId ?? null,
    status: result.ok ? "sent" : "failed",
    error: result.error ?? null,
  });
  if (auditError) {
    // Loud, but not fatal: the email has already gone. Losing the record is a
    // real problem for a later dispute, and silence about it would be worse.
    console.error("send-statement: audit row NOT recorded", auditError.message);
  }

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, from: SENDER_ADDRESS, to },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message_id: result.messageId,
    from: SENDER_ADDRESS,
    to,
    // True whenever a real send happened: a statement has no non-restaurant
    // default destination, so any successful send reached the address the CRM
    // chose. Surface it next to the address, not instead of it.
    sent_to_restaurant: true,
    audit_recorded: !auditError,
    // Said plainly because it is the limit of what this endpoint can promise.
    delivery: "accepted by Gmail; not a delivery confirmation",
  });
}
