/**
 * Alert delivery. Two channels with deliberately different thresholds.
 *
 * A webhook (Slack/Discord) is free and glanceable, so it gets everything.
 * SMS costs money per segment and interrupts someone's evening, so it gets
 * only what genuinely means orders are not reaching a kitchen right now.
 * Texting someone a warning they cannot act on is how a channel gets muted,
 * and a muted channel is worse than no channel.
 */
import type { HealthIssue } from "./health";

/** Two SMS segments. Longer costs more and gets truncated by carriers anyway. */
const SMS_MAX = 300;

const truncate = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/**
 * The text to send, or null when nothing warrants one.
 *
 * Only criticals. A burst becomes ONE message with a count and the first few
 * titles - ten separate texts for one power cut would train people to ignore
 * the eleventh, which might be the real one.
 */
export function composeSmsAlert(newIssues: HealthIssue[]): string | null {
  const critical = newIssues.filter((i) => i.severity === "critical");
  if (critical.length === 0) return null;

  if (critical.length === 1) {
    return truncate(`PFD Order Monitor: ${critical[0].title}. ${critical[0].detail}`, SMS_MAX);
  }

  const head = `PFD Order Monitor: ${critical.length} critical issues. `;
  const titles: string[] = [];
  for (const i of critical) {
    const next = [...titles, i.title].join("; ");
    if (head.length + next.length > SMS_MAX - 20) break;
    titles.push(i.title);
  }
  const more = critical.length - titles.length;
  return truncate(head + titles.join("; ") + (more > 0 ? `; +${more} more` : ""), SMS_MAX);
}

/** Recipients from ALERT_SMS_TO, comma or space separated. */
export function smsRecipients(): string[] {
  return (process.env.ALERT_SMS_TO || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Which SMS settings are absent, by NAME only - never values.
 *
 * twilioConfigured() answers "can we text?" with a bare boolean, which is
 * enough to suppress sending but useless for fixing it: an empty env var and
 * a missing one look identical, and a var can exist in the dashboard with no
 * value behind it. Naming the gap turns a redeploy-and-guess loop into one
 * obvious fix.
 */
export function smsConfigGaps(): string[] {
  const gaps: string[] = [];
  if (!process.env.TWILIO_ACCOUNT_SID) gaps.push("TWILIO_ACCOUNT_SID");
  if (!process.env.TWILIO_AUTH_TOKEN) gaps.push("TWILIO_AUTH_TOKEN");
  if (!process.env.TWILIO_FROM_NUMBER) gaps.push("TWILIO_FROM_NUMBER");
  if (!smsRecipients().length) gaps.push("ALERT_SMS_TO");
  return gaps;
}

export function twilioConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER &&
    smsRecipients().length
  );
}

/**
 * Sends one SMS per recipient via Twilio's REST API - plain fetch with basic
 * auth, no SDK. Never throws: a delivery failure must not break the health
 * check that produced the alert.
 */
export async function sendSms(body: string): Promise<{ sent: number; failed: number }> {
  if (!twilioConfigured()) return { sent: 0, failed: 0 };

  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_FROM_NUMBER!;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  let sent = 0;
  let failed = 0;
  for (const to of smsRecipients()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        sent++;
      } else {
        failed++;
        // Log the reason, never the credentials.
        console.error("Twilio SMS failed", res.status, (await res.text()).slice(0, 200));
      }
    } catch (err) {
      failed++;
      console.error("Twilio SMS error", err instanceof Error ? err.message : err);
    }
  }
  return { sent, failed };
}

/** Slack/Discord-compatible webhook. Also never throws. */
export async function sendWebhook(text: string): Promise<boolean> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source: "pfd-order-monitor" }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (err) {
    console.error("alert webhook failed", err instanceof Error ? err.message : err);
    return false;
  }
}
