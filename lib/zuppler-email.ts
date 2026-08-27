/**
 * Recognising Zuppler order emails and recovering the order uuid from them.
 *
 * PFD receives a Zuppler email for every order (and for later adjustments),
 * which is a second, independent way to learn an order_uuid - useful before
 * the webhook is live, and as a backstop if it ever stops firing. The uuid is
 * all we take from the email: the order itself is then fetched from Zuppler's
 * API, so this path and the webhook produce identical orders.
 */

/** Order uuid as it appears in a receipt URL: /receipt/<uuid>. */
const RECEIPT_UUID = /\/receipt\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Hosts whose links we are willing to follow.
 *
 * These links come out of email content, so following them blindly would let
 * anyone who can email this inbox make the server issue arbitrary requests.
 * The allowlist is the control: only Zuppler and the tracking domain their
 * mail provider wraps links in.
 */
const FOLLOWABLE_HOSTS = [
  /(^|\.)zuppler\.com$/i,
  /(^|\.)zplr\.io$/i,
  /(^|\.)ct\.sendgrid\.net$/i,
];

const isFollowable = (url: string): boolean => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return FOLLOWABLE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
};

/**
 * True for a Zuppler order notification. Two subject shapes seen in the wild:
 *
 *   "Attention: Order Updated for Greg Bishop (#2bed4416)"
 *   "80eb0e25:Delivery order received for marquita clark for ... for $71.09"
 *
 * The second is what PFD's own order emails look like - they are Zuppler
 * emails, relayed. That matters: such an order can be fetched from Zuppler's
 * API in full rather than scraped out of the HTML.
 *
 * The hex-id form additionally requires the body to reference Zuppler, so a
 * lookalike subject from elsewhere is not routed down this path.
 */
export function isZupplerOrderEmail(subject: string, html?: string | null): boolean {
  const subj = String(subject ?? "").replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, "");
  const mentionsZuppler = !!html && /zuppler\.com|zplr\.io/i.test(html);

  if (/\border\b/i.test(subj) && /\(#[0-9a-f]{6,}\)/i.test(subj)) return true;
  if (/^[0-9a-f]{8}\s*:/i.test(subj) && mentionsZuppler) return true;
  return mentionsZuppler && /\breceipt\b/i.test(html!);
}

/**
 * Anchor text that means "this link DOES something" - accepting, rejecting or
 * cancelling an order. Zuppler's restaurant notification contains exactly
 * these two buttons and nothing else, so fetching its links to hunt for a
 * uuid would accept or reject a live order.
 */
const ACTION_TEXT = /\b(accept|reject|decline|approve|confirm|cancel|void|refund|delete|remove|unsubscribe)\b/i;

/** Anchor text that means "this link SHOWS something" - safe to follow. */
const RECEIPT_TEXT = /\b(receipt|view|details?)\b/i;

/** Extracts hrefs from an HTML body, de-duplicated, allowlisted hosts only. */
export function followableLinks(html: string): string[] {
  const hrefs = [...String(html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1].replace(/&amp;/g, "&"))
    .filter(isFollowable);
  return [...new Set(hrefs)];
}

/**
 * Links that are safe to FETCH, judged by their visible text.
 *
 * The host allowlist stops us calling a stranger's server; it says nothing
 * about what a link does on a trusted one. Zuppler's own emails carry
 * "Accept Order" and "Reject Order" buttons, and following those would act on
 * a real order - irreversibly, on someone's dinner.
 *
 * Tracking links are opaque before they are followed, so the visible text is
 * the only signal available in advance. The rule is therefore allow-list, not
 * deny-list: follow a link only if its text positively says it shows a
 * receipt, and never if it reads like an action. An email with no clearly
 * safe link yields nothing, which is the correct outcome - failing to read a
 * uuid costs a fallback, clicking Accept costs an order.
 */
export function safeToFetchLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of String(html ?? "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!isFollowable(href)) continue;
    if (ACTION_TEXT.test(text)) continue;
    if (!RECEIPT_TEXT.test(text)) continue;
    out.push(href);
  }
  return [...new Set(out)];
}

/**
 * Finds the order uuid for a Zuppler email.
 *
 * Prefers a uuid already present in the body; otherwise resolves the wrapped
 * tracking links (bounded in number, allowlisted, short timeout) and reads the
 * uuid out of the final URL.
 */
export async function extractZupplerOrderUuid(
  html: string,
  opts: { maxLinks?: number; timeoutMs?: number } = {}
): Promise<string | null> {
  const maxLinks = opts.maxLinks ?? 4;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const links = followableLinks(html);

  // Only ever trust a uuid that appears in a URL on an allowlisted host.
  // Scanning the whole body instead would let anyone who can email this
  // inbox inject an arbitrary order uuid - not SSRF, since the link is never
  // fetched, but it would ingest a stranger's order into this restaurant.
  for (const link of links) {
    const m = decodeURIComponent(link).match(RECEIPT_UUID);
    if (m) return m[1].toLowerCase();
  }

  // Only links whose visible text says they show a receipt get fetched. An
  // "Accept Order" button is allowlisted by host but must never be followed.
  for (const link of safeToFetchLinks(html).slice(0, maxLinks)) {
    try {
      const res = await fetch(link, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The uuid rides in the final URL (…?zru=%2Freceipt%2F<uuid>), so decode
      // before matching - it arrives percent-encoded.
      const finalUrl = decodeURIComponent(res.url || "");
      const fromUrl = finalUrl.match(RECEIPT_UUID) ?? finalUrl.match(ANY_UUID);
      if (fromUrl) return (fromUrl[1] ?? fromUrl[0]).toLowerCase();
    } catch {
      // A dead or slow tracking link is not fatal - try the next one.
    }
  }
  return null;
}

/**
 * Resolves a Zuppler order uuid from whatever someone has to hand: a bare
 * uuid, a receipt URL, a wrapped tracking link, or a pasted email body.
 *
 * This is how a restaurant's Zuppler ID is discovered without waiting for
 * their first live order - Zuppler's API exposes only order(id), so there is
 * no restaurant lookup, but every receipt points at an order and every order
 * carries its restaurantId.
 */
export async function resolveZupplerOrderUuid(
  input: string,
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  const text = String(input ?? "").trim();
  if (!text) return null;

  // A uuid on its own.
  const bare = text.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (bare) return text.toLowerCase();

  // A single URL. Same allowlist as email links: this is operator-supplied
  // rather than attacker-supplied, but the server should still only be
  // making requests to Zuppler and their mail provider.
  if (/^https?:\/\//i.test(text) && !/\s/.test(text)) {
    const direct = decodeURIComponent(text).match(RECEIPT_UUID);
    if (direct) return direct[1].toLowerCase();
    return extractZupplerOrderUuid(`<a href="${text.replace(/"/g, "&quot;")}">x</a>`, opts);
  }

  // Anything else: treat it as an email body / pasted blob.
  return extractZupplerOrderUuid(text, opts);
}
