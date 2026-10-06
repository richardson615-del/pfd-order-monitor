/**
 * Messages between a restaurant's tablet and Premium dispatch (migration 048).
 *
 * Matt, 2026-10-06: two-way, with quick picks - "Where's my driver?",
 * "Problem with an order", and "Update menu" (the restaurant keeps its own
 * menu current; the CRM makes it a menu change set for the menu agent). The kitchen writes from the tablet; the CRM pulls
 * new ones through GET /api/crm/messages and opens a dispatch ticket; a
 * dispatcher's reply comes back through POST /api/crm/messages.
 *
 * Pure: the routes read and write, this decides what a message may be. The
 * restaurant is never taken from here - the routes get it from the session
 * (tablet) or the CRM key + the restaurant ref (CRM).
 */
import type { Order } from "./types";
import type { MenuChanges } from "./menu-editor";

export const MESSAGE_KINDS = ["text", "driver_late", "order_problem", "menu_change"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type MessageDirection = "from_restaurant" | "to_restaurant";

export const MAX_BODY = 1000;
export const MAX_AUTHOR = 80;
/** A kitchen can send this many in RATE_WINDOW_MS. A stuck finger is not a conversation. */
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 10 * 60_000;
/** How much of the thread the tablet shows. */
export const THREAD_LIMIT = 50;

export interface RestaurantMessage {
  id: string;
  restaurant_id: string;
  direction: MessageDirection;
  kind: MessageKind;
  body: string;
  order_id: string | null;
  author: string | null;
  crm_ticket_no: string | null;
  created_at: string;
  read_at: string | null;
  /** kind = menu_change made from the Menu tab (migration 049): the exact changes. Null on a typed one. */
  menu_changes?: MenuChanges | null;
}

/** What the kitchen sees on the quick-pick buttons, and the words sent when they add none. */
export const QUICK_PICKS: Record<Exclude<MessageKind, "text">, { label: string; defaultBody: string | null }> = {
  driver_late: { label: "Where's my driver?", defaultBody: "Where's my driver?" },
  order_problem: { label: "Problem with an order", defaultBody: "Problem with this order." },
  // No default: a menu change is only the words the restaurant writes.
  menu_change: { label: "Update menu", defaultBody: null },
};

/**
 * Shown in the Update menu box. Plain English is fine - the CRM's menu parser
 * reads it, asks dispatch about anything it cannot match to the menu, and
 * nothing is published until a person approves it.
 */
export const MENU_CHANGE_EXAMPLES = [
  "Out of banana pudding today",
  "Ribs are now $24.99",
  "Brisket plate is back",
  "Rename Pulled Pork Plate to Pork Plate",
];

export type SendInput = { kind?: unknown; body?: unknown; order_id?: unknown };
export type SendDecision =
  | { ok: true; kind: MessageKind; body: string; orderId: string | null }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const cleanBody = (v: unknown): string =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";

/**
 * Validate a message the tablet wants to send. `driver_late` and
 * `order_problem` may come with no words (the default is used); a plain
 * `text` must say something. `order_problem` must name an order.
 */
export function parseTabletMessage(input: SendInput): SendDecision {
  const kind = (typeof input.kind === "string" ? input.kind : "text") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) return { ok: false, error: "unknown message type" };
  let body = cleanBody(input.body);
  if (body.length > MAX_BODY) return { ok: false, error: `message is too long (${MAX_BODY} characters max)` };
  if (!body) {
    if (kind === "menu_change") return { ok: false, error: "write what changed on the menu" };
    const fallback = kind === "text" ? null : QUICK_PICKS[kind].defaultBody;
    if (!fallback) return { ok: false, error: "write a message first" };
    body = fallback;
  }
  let orderId: string | null = null;
  if (input.order_id !== undefined && input.order_id !== null && input.order_id !== "") {
    if (typeof input.order_id !== "string" || !UUID.test(input.order_id)) return { ok: false, error: "bad order" };
    orderId = input.order_id;
  }
  if (kind === "order_problem" && !orderId) return { ok: false, error: "pick the order first" };
  return { ok: true, kind, body, orderId };
}

/**
 * The order "Where's my driver?" is about: the newest delivery that is not
 * done yet. Null when there is none - the message still goes, just unattached.
 */
export function driverLateOrder<T extends Pick<Order, "id" | "order_type" | "status" | "received_at">>(orders: T[]): T | null {
  const open = orders
    .filter((o) => o.order_type === "delivery" && o.status !== "completed" && o.status !== "cancelled")
    .sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
  return open[0] ?? null;
}

/** True when the kitchen has already sent RATE_LIMIT messages in the window. */
export function overRateLimit(recentSentAt: string[], now: number): boolean {
  return recentSentAt.filter((t) => now - Date.parse(t) < RATE_WINDOW_MS).length >= RATE_LIMIT;
}

/** Dispatch replies the tablet has not shown yet. */
export const unreadCount = (msgs: Pick<RestaurantMessage, "direction" | "read_at">[]): number =>
  msgs.filter((m) => m.direction === "to_restaurant" && !m.read_at).length;

/**
 * Replies that arrived since the tablet last looked, by id - what the chime
 * and the "Dispatch replied" banner fire on. `seen` is null on the first load
 * so a tablet that reloads does not ring for an old reply.
 */
export function newReplies(msgs: Pick<RestaurantMessage, "id" | "direction">[], seen: Set<string> | null): string[] {
  if (!seen) return [];
  return msgs.filter((m) => m.direction === "to_restaurant" && !seen.has(m.id)).map((m) => m.id);
}

export type ReplyInput = { restaurant?: unknown; body?: unknown; author?: unknown; ticket_no?: unknown };
export type ReplyDecision =
  | { ok: true; restaurantRef: string; body: string; author: string | null; ticketNo: string | null }
  | { ok: false; error: string };

/** Validate a dispatch reply from the CRM (POST /api/crm/messages). */
export function parseCrmReply(input: ReplyInput): ReplyDecision {
  const ref = typeof input.restaurant === "string" ? input.restaurant.trim() : "";
  if (!ref) return { ok: false, error: "restaurant is required" };
  const body = cleanBody(input.body);
  if (!body) return { ok: false, error: "body is required" };
  if (body.length > MAX_BODY) return { ok: false, error: `body is too long (${MAX_BODY} characters max)` };
  const author = cleanBody(input.author).slice(0, MAX_AUTHOR) || null;
  const t = input.ticket_no;
  const ticketNo = typeof t === "number" ? String(t) : typeof t === "string" && t.trim() ? t.trim().replace(/^#/, "").slice(0, 20) : null;
  return { ok: true, restaurantRef: ref, body, author, ticketNo };
}
