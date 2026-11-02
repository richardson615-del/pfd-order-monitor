/**
 * GL1: calls to the deployment under test (a gl/** preview on the bridge dev
 * database). Same routes the CRM, the printer and the tablet call.
 *
 *   GL_BRIDGE_BASE_URL     the preview URL (production hostname refused)
 *   GL_CRM_WRITE_KEY       that deployment's CRM_WRITE_KEY (Preview env)
 *   GL_VERCEL_BYPASS       optional: Vercel "Protection Bypass for Automation"
 *                          secret, when the preview is behind Vercel auth
 *   GL_EXTRA_PROD_HOSTS    optional, comma-separated: more hostnames to refuse
 */
import { checkBaseUrl } from "./lib";

export function baseUrl(): string {
  const raw = process.env.GL_BRIDGE_BASE_URL;
  const refusal = checkBaseUrl(raw, (process.env.GL_EXTRA_PROD_HOSTS ?? "").split(","));
  if (refusal) throw new Error(`REFUSED: ${refusal}`);
  return raw!.replace(/\/+$/, "");
}

function bypass(): Record<string, string> {
  const s = process.env.GL_VERCEL_BYPASS;
  return s ? { "x-vercel-protection-bypass": s } : {};
}

export interface Reply<T = any> {
  status: number;
  ok: boolean;
  body: T;
  text: string;
  ms: number;
}

export async function call<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...bypass(), ...((init.headers as Record<string, string>) ?? {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const t0 = Date.now();
  const res = await fetch(baseUrl() + path, { ...init, headers, body });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON (the Epson route answers XML) */
  }
  return { status: res.status, ok: res.ok, body: parsed, text, ms: Date.now() - t0 };
}

/** A CRM call: Bearer CRM_WRITE_KEY, as prs-crm/src/lib/printer-bridge.ts sends it. */
export function crm<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Reply<T>> {
  const key = process.env.GL_CRM_WRITE_KEY;
  if (!key) throw new Error("GL_CRM_WRITE_KEY is required (the preview's CRM_WRITE_KEY)");
  return call<T>(path, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${key}` } });
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
