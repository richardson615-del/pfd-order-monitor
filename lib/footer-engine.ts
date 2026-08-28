import { randomBytes } from "crypto";
import { supabaseAdmin } from "./supabase-server";

/**
 * Resolves the footer for one order, at INGEST.
 *
 * Deliberately not at print time. The print path must not run queries while a
 * cook is waiting, and a ticket reprinted tomorrow has to say what it said
 * today - a coupon code or expiry recomputed on reprint would silently differ
 * from the one the customer is holding.
 *
 * Everything here is best-effort: any failure returns null and the ticket
 * falls back to the restaurant's static footer. A footer is marketing; an
 * order is dinner.
 */

export type TemplateId =
  | "direct_coupon"
  | "scan_reward"
  // Shipped disabled. Prize promotions have registration and disclosure
  // requirements that vary by state, and neither runs for a real restaurant
  // until that has been reviewed by someone qualified.
  | "milestone_counter"
  | "mystery_qr";

export const ENABLED_TEMPLATES: TemplateId[] = ["direct_coupon", "scan_reward"];

export interface TemplateField {
  key: string;
  type: "string" | "number" | "url";
  required: boolean;
  default?: string | number | null;
  label: string;
  help?: string;
}

export interface TemplateSpec {
  id: TemplateId;
  label: string;
  enabled: boolean;
  /** Why it is off, when it is. Shown by the picker rather than a bare "no". */
  disabled_reason?: string;
  description: string;
  prints_qr: boolean;
  config: TemplateField[];
  sample_footer: string;
}

/**
 * The catalogue the CRM picker is built from.
 *
 * Served rather than duplicated, so a template added here appears in the
 * console without a second edit in another repo - which is exactly how the
 * printer bridge client drifted out of step with this app once already.
 */
export const TEMPLATE_CATALOG: TemplateSpec[] = [
  {
    id: "direct_coupon",
    label: "Direct-order coupon",
    enabled: true,
    description:
      "Prints a unique discount code for the customer's next order placed direct, with an expiry date. The QR opens the restaurant's own site; the code is on the paper, so nothing needs looking up.",
    prints_qr: true,
    config: [
      { key: "percent", type: "number", required: true, default: 10,
        label: "Discount %", help: "1-100. This comes out of the restaurant's margin." },
      { key: "expiry_days", type: "number", required: false, default: 30,
        label: "Valid for (days)" },
      { key: "site_url", type: "url", required: false, default: null,
        label: "Ordering site", help: "Defaults to the restaurant's footer URL." },
    ],
    sample_footer:
      "15% off your next direct order\nariellarestaurant.net\nCode QRCWBS\nExpires Sep 26",
  },
  {
    id: "scan_reward",
    label: "Scan reward",
    enabled: true,
    description:
      "A QR the customer scans for an unconditional reward. The page can also offer the restaurant's review link, with nothing attached to it - rewarding reviews breaches Google's policies and the penalty falls on the restaurant's listing.",
    prints_qr: true,
    config: [
      { key: "reward", type: "string", required: true, default: "a treat on your next visit",
        label: "Reward", help: "Shown on the page and honoured by staff." },
      { key: "review_url", type: "url", required: false, default: null,
        label: "Review link (optional)",
        help: "Offered on the page. Never a condition of the reward." },
    ],
    sample_footer: "Thanks, Sam!\nScan for a free dessert on your next visit",
  },
  {
    id: "milestone_counter",
    label: "Milestone prize",
    enabled: false,
    disabled_reason:
      "Prize promotions carry registration and disclosure duties that vary by state. Disabled until the promotional rules have been reviewed by a lawyer.",
    description: "Counts a restaurant's orders and awards a prize on a chosen number.",
    prints_qr: false,
    config: [
      { key: "milestone", type: "number", required: true, default: 1000, label: "Winning order number" },
      { key: "prize", type: "string", required: true, default: null, label: "Prize" },
      { key: "fine_print", type: "string", required: true, default: null, label: "Fine print" },
    ],
    sample_footer: "You're order #847 this year. Order #1000 wins a free meal.",
  },
  {
    id: "mystery_qr",
    label: "Mystery prize QR",
    enabled: false,
    disabled_reason:
      "A game of chance tied to a purchase. Needs a genuine no-purchase route and honest odds disclosure, reviewed by a lawyer, before it can run.",
    description: "A scannable one-in-N chance of a prize.",
    prints_qr: true,
    config: [
      { key: "odds", type: "number", required: true, default: 100, label: "Odds (1 in N)" },
      { key: "prize", type: "string", required: true, default: null, label: "Prize" },
      { key: "fine_print", type: "string", required: true, default: null, label: "Fine print" },
    ],
    sample_footer: "SCAN ME - 1 in 100 wins a free entree.",
  },
];

export interface ResolvedFooter {
  text: string;
  url: string | null;
  template_id: TemplateId;
  token: string | null;
  payload: Record<string, unknown>;
}

export interface FooterContext {
  restaurantId: string;
  orderId: string;
  customerName?: string | null;
  publicBaseUrl?: string;
}

/** Unambiguous when read off paper and typed in: no O/0, I/1, U/V. */
function shortCode(len = 6): string {
  const alphabet = "ABCDEFGHJKMNPQRSTWXYZ23456789";
  return Array.from(randomBytes(len))
    .map((b) => alphabet[b % alphabet.length])
    .join("");
}

/** URL-safe, long enough that tokens cannot be walked. */
const newToken = () => randomBytes(16).toString("base64url");

const firstName = (full?: string | null): string | null => {
  const n = String(full ?? "").trim().split(/\s+/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : null;
};

function shortDate(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric",
    timeZone: process.env.TICKET_TIMEZONE || "America/Chicago",
  });
}

export function publicBase(): string {
  return (
    process.env.PUBLIC_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://pfd-order-monitor.vercel.app"
  );
}

/**
 * Builds the footer for one order. Returns null to mean "use the static
 * footer" - which is the answer for every unexpected case, not an error path.
 */
export async function resolveFooter(
  restaurant: {
    id: string;
    footer_engine?: string | null;
    footer_template_id?: string | null;
    footer_template_config?: Record<string, any> | null;
    ticket_footer_url?: string | null;
  },
  ctx: FooterContext
): Promise<ResolvedFooter | null> {
  try {
    if (restaurant.footer_engine !== "dynamic") return null;

    const templateId = String(restaurant.footer_template_id ?? "") as TemplateId;
    if (!ENABLED_TEMPLATES.includes(templateId)) {
      if (templateId) {
        console.error(
          "footer: template not enabled, falling back to static:",
          templateId, "restaurant", restaurant.id
        );
      }
      return null;
    }

    const cfg = restaurant.footer_template_config ?? {};
    const admin = supabaseAdmin();
    const base = ctx.publicBaseUrl || publicBase();

    if (templateId === "direct_coupon") {
      const percent = Number(cfg.percent ?? 10);
      const days = Number(cfg.expiry_days ?? 30);
      const site = String(cfg.site_url ?? restaurant.ticket_footer_url ?? "").trim();
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
      const code = shortCode();

      const text = [
        `${percent}% off your next direct order`,
        site ? site.replace(/^https?:\/\//i, "").replace(/\/$/, "") : null,
        `Code ${code}`,
        `Expires ${shortDate(days)}`,
      ].filter(Boolean).join("\n");

      await admin.from("footer_events").insert({
        restaurant_id: restaurant.id, order_id: ctx.orderId,
        template_id: templateId, kind: "rendered",
        payload: { code, percent, expires_in_days: days },
      });

      // The QR goes to the restaurant's own site - the code is already
      // printed, so there is nothing to look up.
      return {
        text, url: site || null, template_id: templateId, token: null,
        payload: { code, percent },
      };
    }

    if (templateId === "scan_reward") {
      // Reshaped from the original "leave a review for a reward": Google
      // prohibits incentivised reviews, and the penalty lands on the
      // restaurant's listing. The reward is for SCANNING and is
      // unconditional; the review link is offered on the page with nothing
      // attached to it.
      const reward = String(cfg.reward ?? "a treat on your next visit").trim();
      const token = newToken();
      const name = firstName(ctx.customerName);

      const { error } = await admin.from("footer_tokens").insert({
        token, restaurant_id: restaurant.id, order_id: ctx.orderId,
        template_id: templateId,
        payload: { reward, review_url: cfg.review_url ?? null },
      });
      if (error) {
        console.error("footer: could not mint token, using static:", error.message);
        return null;
      }

      await admin.from("footer_events").insert({
        restaurant_id: restaurant.id, order_id: ctx.orderId,
        template_id: templateId, kind: "rendered", token,
        payload: { reward },
      });

      return {
        text: [
          name ? `Thanks, ${name}!` : "Thanks for your order!",
          `Scan for ${reward}`,
        ].join("\n"),
        url: `${base}/f/${token}`,
        template_id: templateId,
        token,
        payload: { reward },
      };
    }

    return null;
  } catch (err) {
    console.error(
      "footer: resolve failed, using static:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Next order number for a restaurant - atomic, and never a count(*). */
export async function nextOrderNumber(restaurantId: string): Promise<number | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .rpc("next_restaurant_order_number", { rid: restaurantId });
    if (error) return null;
    return typeof data === "number" ? data : null;
  } catch {
    return null;
  }
}
