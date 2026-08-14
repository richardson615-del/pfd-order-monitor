import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { collectSnapshot, evaluateHealth, sortIssues, type HealthIssue } from "@/lib/health";
import { composeSmsAlert, sendSms, sendWebhook, twilioConfigured } from "@/lib/alerts";

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

  const fresh = issues.filter((i) => !openKeys.has(i.key));
  for (const i of issues) {
    await admin.from("monitor_alerts").upsert(
      {
        key: i.key,
        severity: i.severity,
        title: i.title,
        detail: i.detail,
        last_seen_at: now,
        resolved_at: null,
        ...(openKeys.has(i.key) ? {} : { first_seen_at: now, notified_at: now }),
      },
      { onConflict: "key" }
    );
  }

  // Anything previously open and no longer reported has cleared.
  const resolvedKeys = [...openKeys].filter((k) => !currentKeys.has(k));
  if (resolvedKeys.length) {
    await admin.from("monitor_alerts").update({ resolved_at: now }).in("key", resolvedKeys);
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
      sms_sent: sms.sent,
      sms_failed: sms.failed,
    },
    issues,
  });
}
