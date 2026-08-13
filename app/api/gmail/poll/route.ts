import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { listOrderMessageIds, getMessageContent } from "@/lib/gmail";
import {
  parseOrderEmail,
  parseDueTimeToDate,
  moneyToNumber,
  extractOrderNumberFromSubject,
} from "@/lib/parser";
import { ingestOrder } from "@/lib/canonical";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Polls every active Gmail inbox for new order emails, parses them, stores
 * them, and sends a push notification. Designed to be called on a schedule
 * (see vercel.json) and protected by CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: inboxes, error } = await admin
    .from("monitored_inboxes")
    .select("*")
    .eq("provider", "gmail")
    .eq("is_active", true);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Record<string, any> = {};

  for (const inbox of inboxes || []) {
    if (!inbox.gmail_refresh_token) {
      results[inbox.email_address] = { skipped: "no refresh token" };
      continue;
    }

    try {
      // Look back further on the very first poll, then just cover the gap since last poll.
      const lastPoll = inbox.gmail_last_poll_at
        ? new Date(inbox.gmail_last_poll_at)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);
      // Generous overlap on purpose. The watermark advances on every
      // successful poll, so anything not ingested on the pass it arrived in
      // (sitting in spam, a parse failure, a transient Gmail error) falls
      // outside the window within the overlap and is then invisible forever.
      // Re-scanning is free: ingestOrder de-duplicates on gmail_message_id.
      const overlapSeconds = Number(process.env.GMAIL_POLL_OVERLAP_SECONDS || 3600);
      const afterEpoch = Math.floor(lastPoll.getTime() / 1000) - overlapSeconds;

      const messageIds = await listOrderMessageIds(
        inbox.gmail_refresh_token,
        inbox.sender_filter,
        afterEpoch
      );

      let created = 0;
      // Why a message was skipped, not just how many. "checked: 1, created: 0"
      // is indistinguishable between "already had it" and "could not read the
      // subject", which turns every miss into a guessing game.
      const skipped: Record<string, number> = {};
      const skippedSubjects: string[] = [];
      const note = (reason: string, subject?: string) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        if (subject && skippedSubjects.length < 5) {
          skippedSubjects.push(`${reason}: ${subject.slice(0, 80)}`);
        }
      };
      for (const messageId of messageIds) {
        // Skip if we've already stored this message
        const { data: existing } = await admin
          .from("orders")
          .select("id")
          .eq("gmail_message_id", messageId)
          .maybeSingle();
        if (existing) {
          note("already_ingested");
          continue;
        }

        const { subject, html } = await getMessageContent(
          inbox.gmail_refresh_token,
          messageId
        );

        const orderNumber = extractOrderNumberFromSubject(
          subject,
          inbox.subject_pattern
        );
        // Not an order email we recognise - record which check rejected it.
        if (!orderNumber) {
          note("subject_did_not_match", subject);
          continue;
        }
        if (!html) {
          note("no_html_body", subject);
          continue;
        }

        const parsed = parseOrderEmail(html);

        const result = await ingestOrder({
          source: "email",
          externalId: messageId,
          restaurantId: inbox.restaurant_id,
          inboxId: inbox.id,
          orderNumber,
          ticketRestaurantName: parsed.ticketRestaurantName,
          orderType: parsed.orderType,
          dueTime: parseDueTimeToDate(parsed.dueTime)?.toISOString() ?? null,
          customerName: parsed.customerName,
          customerPhone: parsed.customerPhone,
          customerAddress: parsed.customerAddress,
          items: parsed.items,
          itemsTotal: moneyToNumber(parsed.itemsTotal),
          tax: moneyToNumber(parsed.tax),
          serviceFee: moneyToNumber(parsed.serviceFee),
          customerTotal: moneyToNumber(parsed.customerTotal),
          paymentType: parsed.paymentType,
          rawHtml: html,
        });

        if (result.status === "error") {
          console.error("Ingest failed for", messageId, result.error);
          note("ingest_error");
          continue;
        }
        if (result.status === "created") created++;
        else if (result.status === "updated") note("updated");
        else note("duplicate_in_ingest");
      }

      await admin
        .from("monitored_inboxes")
        .update({ gmail_last_poll_at: new Date().toISOString() })
        .eq("id", inbox.id);

      results[inbox.email_address] = {
        checked: messageIds.length,
        created,
        ...(Object.keys(skipped).length ? { skipped } : {}),
        ...(skippedSubjects.length ? { details: skippedSubjects } : {}),
      };
    } catch (err: any) {
      console.error("Poll failed for", inbox.email_address, err);
      results[inbox.email_address] = { error: err.message };
    }
  }

  return NextResponse.json({ ok: true, results });
}
