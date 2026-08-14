import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { collectSnapshot, evaluateHealth, sortIssues, type HealthIssue } from "@/lib/health";

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
 * Delivery is a webhook (ALERT_WEBHOOK_URL) because that works with Slack,
 * Discord, Zapier or anything else without this project holding new
 * credentials. Unset, it still records state and serves the admin panel -
 * the checks are useful even with nowhere to send them.
 */
async function notify(text: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` is what Slack and Discord both read; anything else gets the
      // whole body and can pick out what it wants.
      body: JSON.stringify({ text, source: "pfd-order-monitor" }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // A broken alert channel must never break the check that feeds it.
    console.error("alert webhook failed", err instanceof Error ? err.message : err);
  }
}

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

  if (fresh.length) {
    await notify(
      `*Order Monitor: ${fresh.length} new issue${fresh.length > 1 ? "s" : ""}*\n\n` +
        fresh.map(line).join("\n\n")
    );
  }
  if (resolvedKeys.length) {
    await notify(`✅ Order Monitor: ${resolvedKeys.length} issue(s) cleared.`);
  }

  return NextResponse.json({
    ok: true,
    checked_at: now,
    open: issues.length,
    new: fresh.length,
    resolved: resolvedKeys.length,
    issues,
  });
}
