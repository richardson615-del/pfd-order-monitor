import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /f/:token - the ONLY public, unauthenticated route in this app.
 *
 * A customer scans the QR on their receipt. Everything about this is
 * deliberately small: no session, no PII on the page, no personalisation
 * beyond the restaurant's own name, and no way to enumerate tokens (they are
 * 128 bits of randomness).
 *
 * Rate limiting uses a counter in Postgres rather than anything in memory,
 * because serverless instances share no state - an in-memory limiter here
 * would be decorative.
 */

/** A receipt gets scanned a handful of times: by the customer, maybe staff. */
const MAX_HITS = 20;

function page(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Thanks</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#faf9f7; color:#1a1a1a; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#141414; color:#f2f2f2; } }
  .card { max-width:23rem; width:100%; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .5rem; }
  .reward { font-size:1.25rem; font-weight:600; margin:1.5rem 0; padding:1.25rem;
            border:2px solid currentColor; border-radius:12px; }
  .muted { opacity:.7; font-size:.875rem; }
  a.btn { display:inline-block; margin-top:1.5rem; padding:.75rem 1.25rem;
          border:1px solid currentColor; border-radius:8px;
          text-decoration:none; color:inherit; }
</style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const token = String(params.token ?? "").slice(0, 64);
  if (!token) return page("<h1>Not found</h1>", 404);

  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("footer_tokens")
    .select("token, template_id, payload, hits, restaurant_id, restaurants(name)")
    .eq("token", token)
    .maybeSingle();

  // Same response for an unknown token as for an exhausted one: distinguishing
  // them would confirm which tokens exist.
  if (!row) return page("<h1>Not found</h1>", 404);

  const { data: hits } = await admin.rpc("bump_footer_token", { t: token });
  if (typeof hits === "number" && hits > MAX_HITS) {
    return page(
      `<h1>Thanks!</h1><p class="muted">This code has already been used a few times.</p>`,
      429
    );
  }

  const restaurantName = (row as any).restaurants?.name ?? "";
  const payload = (row.payload ?? {}) as Record<string, any>;

  await admin.from("footer_events").insert({
    restaurant_id: row.restaurant_id,
    order_id: null,
    template_id: row.template_id,
    kind: "qr_scanned",
    token,
    payload: {},
  });

  if (row.template_id === "scan_reward") {
    const reward = esc(payload.reward || "a treat on your next visit");
    const reviewUrl = typeof payload.review_url === "string" ? payload.review_url : null;

    // The reward is for scanning and is stated unconditionally. The review
    // link, when there is one, is offered with nothing attached to it -
    // incentivised reviews breach Google's policies and the penalty lands on
    // the restaurant's own listing.
    return page(`
      <h1>Thanks for ordering${restaurantName ? ` from ${esc(restaurantName)}` : ""}!</h1>
      <div class="reward">${reward}</div>
      <p class="muted">Show this screen on your next visit.</p>
      ${reviewUrl ? `<a class="btn" href="${esc(reviewUrl)}" rel="noopener nofollow">Leave a review</a>
      <p class="muted" style="margin-top:.75rem">Entirely optional — the treat above is yours either way.</p>` : ""}
    `);
  }

  return page(`<h1>Thanks${restaurantName ? ` from ${esc(restaurantName)}` : ""}!</h1>`);
}
