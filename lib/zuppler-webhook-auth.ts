/**
 * Whether the Zuppler webhook takes a call, and how (2026-10-28).
 *
 * Normally a call must carry our token (api-token or Authorization). Some
 * Zuppler deliveries have arrived with no token at all, and each refusal can
 * be a live order that never prints. Matt asked for a switch rather than a
 * call to Zuppler, since Zuppler is being retired:
 *
 *   ZUPPLER_ACCEPT_UNSIGNED=1   (Vercel env; off when unset)
 *
 * With it on, an unsigned call is taken ONLY when its body names a UUID-shaped
 * order id. Nothing else in the body is used: the order is fetched from
 * Zuppler's own API with our credentials, exactly as for a signed call, so an
 * unsigned caller can at most make us pull a real order Zuppler already holds
 * for us. An id Zuppler doesn't know ends as not_found, and nothing is created.
 * Off, behaviour is exactly as before: no token, 401.
 */
export type ZupplerWebhookDecision = "signed" | "unsigned_verify" | "refuse";

export function acceptUnsignedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.ZUPPLER_ACCEPT_UNSIGNED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function isUuidShaped(value: string | null | undefined): boolean {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function zupplerWebhookDecision(args: {
  tokenOk: boolean;
  orderUuid: string | null;
  env?: Record<string, string | undefined>;
}): ZupplerWebhookDecision {
  if (args.tokenOk) return "signed";
  if (acceptUnsignedEnabled(args.env) && isUuidShaped(args.orderUuid)) return "unsigned_verify";
  return "refuse";
}
