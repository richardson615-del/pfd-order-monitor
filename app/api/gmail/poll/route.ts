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
      const afterEpoch = Math.floor(lastPoll.getTime() / 1000) - 120; // 2 min overlap, safer than missing one

      const messageIds = await listOrderMessageIds(
        inbox.gmail_refresh_token,
        inbox.sender_filter,
        afterEpoch
      );

      let created = 0;
      for (const messageId of messageIds) {
        // Skip if we've already stored this message
        const { data: existing } = await admin
          .from("orders")
          .select("id")
          .eq("gmail_message_id", messageId)
          .maybeSingle();
        if (existing) continue;

        const { subject, html } = await getMessageContent(
          inbox.gmail_refresh_token,
          messageId
        );

        const orderNumber = extractOrderNumberFromSubject(
          subject,
          inbox.subject_pattern
        );
        if (!orderNumber || !html) continue; // not an order email we recognize

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
          continue;
        }
        if (result.status === "created") created++;
      }

      await admin
        .from("monitored_inboxes")
        .update({ gmail_last_poll_at: new Date().toISOString() })
        .eq("id", inbox.id);

      results[inbox.email_address] = { checked: messageIds.length, created };
    } catch (err: any) {
      console.error("Poll failed for", inbox.email_address, err);
      results[inbox.email_address] = { error: err.message };
    }
  }

  return NextResponse.json({ ok: true, results });
}
