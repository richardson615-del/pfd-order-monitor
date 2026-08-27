import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { collectSnapshot, evaluateHealth, sortIssues, type HealthIssue } from "@/lib/health";
import { composeSmsAlert, sendSms, sendWebhook, twilioConfigured, smsConfigGaps } from "@/lib/alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/monitor/check   (Authorization: Bearer <CRON_SECRET>)
 *
 * Runs the health checks, remembers what has already been reported, and
 * announces changes. Meant to be called on a schedule alongside the Gmail
 * poll.
 *
 * Every failure this system has produced has been silent - an order reaching
 * the dashboard and never printing, a Gmail token dying, a printer going
 * quiet. All of it is visible in the admin panel, but only to someone who
 * happens to look. This is what does the looking.
 *
 * Two delivery channels, on purpose. ALERT_WEBHOOK_URL (Slack/Discord) is
 * free and glanceable so it gets everything; Twilio SMS costs money per
 * segment and interrupts someone, so it gets criticals only. With neither
 * configured the checks still run and record state.
 */
const line = (i: HealthIssue) =>
  `${i.severity === "critical" ? "\u{1F534}" : "\u{1F7E1}"} ${i.title}\n   ${i.detail}`;

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const issues = sortIssues(evaluateHealth(await collectSnapshot(), new Date()));
  const admin = supabaseAdmin();
  const now = new Date().toISOString();

  const { data: open } = await admin
    .from("monitor_alerts")
    .select("key, notified_at")
    .is("resolved_at", null);
  const openKeys = new Set((open ?? []).map((a) => a.key));
  const currentKeys = new Set(issues.map((i) => i.key));
  // Open, but nobody was ever successfully told. See below.
  const undelivered = new Set(
    (open ?? []).filter((a) => !a.notified_at).map((a) => a.key)
  );

  // "Needs telling" is not the same as "newly appeared". An alert whose
  // delivery failed is still undelivered on the next run, and marking it
  // notified regardless meant a failed send was never retried - the alert
  // was recorded as sent, and the problem went unreported until someone
  // happened to read the endpoint. A printer that is still offline is worth
  // one more attempt.
  const fresh = issues.filter((i) => !openKeys.has(i.key) || undelivered.has(i.key));

  // supabase-js reports failures in `error` rather than throwing, so an
  // unwritable store is silent - and silence here is dangerous in a specific
  // way: without persisted state every run sees every issue as new, so a
  // standing problem would alert on every single run. That is the alert
  // fatigue this table exists to prevent, so treat it as fatal.
  let storeError: string | null = null;
  for (const i of issues) {
    const { error } = await admin.from("monitor_alerts").upsert(
      {
        key: i.key,
        severity: i.severity,
        title: i.title,
        detail: i.detail,
        last_seen_at: now,
        resolved_at: null,
        // notified_at is set AFTER a successful send, not here - writing it
        // now would record an alert as delivered before anyone tried to
        // deliver it, which is how a failed text becomes a silent one.
        ...(openKeys.has(i.key) ? {} : { first_seen_at: now, notified_at: null }),
      },
      { onConflict: "key" }
    );
    if (error) {
      storeError = error.message;
      break;
    }
  }

  // Anything previously open and no longer reported has cleared.
  const resolvedKeys = [...openKeys].filter((k) => !currentKeys.has(k));
  if (!storeError && resolvedKeys.length) {
    const { error } = await admin
      .from("monitor_alerts")
      .update({ resolved_at: now })
      .in("key", resolvedKeys);
    if (error) storeError = error.message;
  }

  if (storeError) {
    // Deliberately no notification: with no memory, notifying would repeat
    // the same alert every run until someone muted the channel. The issues
    // are still returned here and visible to anyone calling the endpoint,
    // and this is now loud in the logs and the response.
    console.error("monitor: alert store unavailable, notifications suppressed", storeError);
    return NextResponse.json(
      {
        ok: false,
        error: `alert store unavailable: ${storeError}`,
        hint: "monitor_alerts table missing or unwritable - see db/migrations/005_monitor_alerts.sql",
        checked_at: now,
        open: issues.length,
        notifications_suppressed: true,
        issues,
      },
      { status: 500 }
    );
  }

  let sms = { sent: 0, failed: 0 };
  if (fresh.length) {
    await sendWebhook(
      `*Order Monitor: ${fresh.length} new issue${fresh.length > 1 ? "s" : ""}*\n\n` +
        fresh.map(line).join("\n\n")
    );
    // Criticals only, and one message however many there are.
    const text = composeSmsAlert(fresh);
    if (text) sms = await sendSms(text);

    // Mark delivered only when something actually got through. With no
    // channel configured at all there is nothing to retry towards, so those
    // are stamped too - otherwise every run would "retry" forever.
    const delivered = sms.sent > 0 || (!twilioConfigured() && !process.env.ALERT_WEBHOOK_URL);
    if (delivered) {
      await admin
        .from("monitor_alerts")
        .update({ notified_at: now })
        .in("key", fresh.map((i) => i.key));
    } else {
      console.error(
        "monitor: alert raised but NOT delivered - will retry next run",
        { keys: fresh.map((i) => i.key), sms_failed: sms.failed }
      );
    }
  }
  if (resolvedKeys.length) {
    await sendWebhook(`✅ Order Monitor: ${resolvedKeys.length} issue(s) cleared.`);
  }

  return NextResponse.json({
    ok: true,
    checked_at: now,
    open: issues.length,
    new: fresh.length,
    resolved: resolvedKeys.length,
    channels: {
      webhook: !!process.env.ALERT_WEBHOOK_URL,
      sms: twilioConfigured(),
      // Names only, never values - so a dead channel says which piece is missing.
      ...(twilioConfigured() ? {} : { sms_missing: smsConfigGaps() }),
      sms_sent: sms.sent,
      sms_failed: sms.failed,
    },
    issues,
  });
}
