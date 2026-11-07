/**
 * The restaurant's menu on its tablet, and the edits made there
 * (migration 049).
 *
 * Matt, 2026-10-06: "updates need to be able to be made on tablet". The CRM
 * pushes the current menu here with its own `ref` on every entry; the Menu
 * tab shows it; a tap on an item becomes a change that names that ref. The
 * change travels as a `menu_change` message (lib/messages.ts) whose
 * `menu_changes.lines` are in the CRM parser's exact grammar, so the CRM
 * never has to guess which "ribs" the kitchen meant.
 *
 * Pure. The routes read and write; this decides what a menu and an edit
 * may be.
 */
import { DAY_KEYS, DAY_LABELS, clockLabel, endOfServiceDay, zonedInstant, zonedParts } from "@/lib/store";

export const MAX_CATEGORIES = 200;
export const MAX_ITEMS = 4000;
export const MAX_NAME = 200;
export const MAX_DESCRIPTION = 1000;
/** A price the tablet may set. Above this it is a typo. */
export const MAX_PRICE_CENTS = 99_900;
/** Changes in one send. The editor sends one at a time; the cap is for the route. */
export const MAX_EDITS = 20;

export interface TabletMenuItem {
  ref: string;
  name: string;
  price_cents: number;
  available: boolean;
  description: string | null;
}

export interface TabletMenuCategory {
  ref: string;
  name: string;
  items: TabletMenuItem[];
}

export interface TabletMenu {
  menu_id: string;
  source: string;
  categories: TabletMenuCategory[];
}

export type MenuPushDecision = { ok: true; menu: TabletMenu; itemCount: number } | { ok: false; error: string };

const REF_RE = /^[A-Za-z0-9._:-]{1,120}$/;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return s && s.length <= max ? s : null;
};

const cents = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null);

/**
 * Validate what the CRM pushes (PUT /api/crm/restaurants/:id/menu). Every
 * entry needs a ref and a name; a bad entry fails the whole push, because
 * a menu with a hole in it would let the kitchen edit an item the CRM
 * cannot find.
 */
export function parseMenuPush(input: unknown): MenuPushDecision {
  const o = (input ?? {}) as Record<string, unknown>;
  const menuId = str(o.menu_id, 80);
  if (!menuId) return { ok: false, error: "menu_id is required" };
  const source = str(o.source, 40) ?? "crm";
  if (!Array.isArray(o.categories)) return { ok: false, error: "categories must be an array" };
  if (o.categories.length > MAX_CATEGORIES) return { ok: false, error: `too many categories (${MAX_CATEGORIES} max)` };

  const seen = new Set<string>();
  const categories: TabletMenuCategory[] = [];
  let itemCount = 0;
  for (const [ci, c] of (o.categories as unknown[]).entries()) {
    const cat = (c ?? {}) as Record<string, unknown>;
    const cref = str(cat.ref, 120);
    const cname = str(cat.name, MAX_NAME);
    if (!cref || !REF_RE.test(cref)) return { ok: false, error: `category ${ci}: bad ref` };
    if (!cname) return { ok: false, error: `category ${ci}: name is required` };
    if (!Array.isArray(cat.items)) return { ok: false, error: `category ${cname}: items must be an array` };
    const items: TabletMenuItem[] = [];
    for (const [ii, it] of (cat.items as unknown[]).entries()) {
      const item = (it ?? {}) as Record<string, unknown>;
      const ref = str(item.ref, 120);
      const name = str(item.name, MAX_NAME);
      const price = cents(item.price_cents);
      if (!ref || !REF_RE.test(ref)) return { ok: false, error: `${cname} item ${ii}: bad ref` };
      if (seen.has(ref)) return { ok: false, error: `item ref ${ref} appears twice` };
      if (!name) return { ok: false, error: `${cname} item ${ii}: name is required` };
      if (price === null) return { ok: false, error: `${name}: price_cents must be a whole number of cents` };
      if (item.available !== undefined && typeof item.available !== "boolean") return { ok: false, error: `${name}: available must be true or false` };
      seen.add(ref);
      items.push({
        ref,
        name,
        price_cents: price,
        available: item.available !== false,
        description: str(item.description, MAX_DESCRIPTION),
      });
      if (++itemCount > MAX_ITEMS) return { ok: false, error: `too many items (${MAX_ITEMS} max)` };
    }
    categories.push({ ref: cref, name: cname, items });
  }
  return { ok: true, menu: { menu_id: menuId, source, categories }, itemCount };
}

/**
 * "How long is it sold out?" (Nick, 2026-11-07, brief MP2): asked on every 86
 * so a one-day sold-out cannot stay on the menu forever. Rest of today is the
 * default.
 */
export const SOLD_OUT_CHOICES = [
  { key: "rest_of_today", label: "Rest of today" },
  { key: "back_at", label: "Back at…" },
  { key: "until_turned_back_on", label: "Until we turn it back on" },
] as const;
export type SoldOutFor = (typeof SOLD_OUT_CHOICES)[number]["key"];
export type BackDay = "today" | "tomorrow";

/** What a tap on the tablet may do to one item. */
export type MenuEdit =
  | { ref: string; action: "set_price"; price_cents: number }
  | { ref: string; action: "sold_out"; sold_out_for?: SoldOutFor; back_day?: BackDay; back_time?: string }
  | { ref: string; action: "back_on" }
  | { ref: string; action: "rename"; name: string };

/** One change as stored on the message and shown in the thread. */
export interface MenuChangeRecord {
  ref: string;
  action: MenuEdit["action"];
  /** The item's name when the edit was made, so the thread still reads right after a rename. */
  item: string;
  /** The parser line the CRM runs. */
  line: string;
  /** What a person reads. */
  text: string;
  /** Sold out only: back on at this time (ISO with the restaurant's offset); null = until someone turns it back on. */
  until?: string | null;
}

export interface MenuChanges {
  menu_id: string;
  lines: string[];
  changes: MenuChangeRecord[];
}

export type MenuEditsDecision = { ok: true; body: string; menuChanges: MenuChanges } | { ok: false; error: string };

/** What the route knows that the tablet may not: the time and the restaurant's own hours. */
export interface SoldOutContext {
  now: Date;
  zone: string;
  hours: unknown;
}

export const money = (c: number) => `$${(c / 100).toFixed(2)}`;

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-07T11:00:00-06:00": the instant as the restaurant's clock reads it. */
export function isoWithOffset(at: Date, zone: string): string {
  const p = zonedParts(at, zone);
  const offset = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - at.getTime()) / 60_000);
  const abs = Math.abs(offset);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}:00${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * When a Rest of today sold-out ends: the restaurant's next opening on a later
 * service day, or 4:00 AM local when no opening is on file. A service day runs
 * to 4 AM (lib/store.ts), so at 1 AM a bar is still on last night's shift and
 * comes back at today's opening, while noon between lunch and dinner, or 9 AM
 * before the doors open, waits for tomorrow: "the rest of today" has to cover
 * today's service.
 */
export function restOfTodayUntil(hours: unknown, now: Date, zone: string): Date {
  const week = (hours && typeof hours === "object" ? hours : {}) as Record<string, unknown>;
  const p = zonedParts(now, zone);
  const serviceDay = Date.UTC(p.y, p.m - 1, p.d) - (p.h < 4 ? 86_400_000 : 0);
  // Eight days: before 4 AM the first day looked at is today, whose opening may have passed.
  for (let offset = 1; offset <= 8; offset++) {
    const day = new Date(serviceDay + offset * 86_400_000);
    const ranges = week[DAY_KEYS[day.getUTCDay()]!];
    if (!Array.isArray(ranges)) continue;
    const opens = (ranges as { open?: unknown }[]).map((r) => r?.open).filter((o): o is string => typeof o === "string" && HHMM.test(o)).sort();
    for (const open of opens) {
      const at = zonedInstant(zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(open.slice(0, 2)), Number(open.slice(3, 5)));
      if (at > now) return at;
    }
  }
  return endOfServiceDay(now, zone);
}

/** "5:30 PM today", "11:00 AM tomorrow", "11:00 AM Monday". */
export function untilLabel(until: string, now: Date, zone: string): string {
  const at = new Date(until);
  const dayOf = (d: Date) => {
    const p = zonedParts(d, zone);
    return Date.UTC(p.y, p.m - 1, p.d);
  };
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : DAY_LABELS[DAY_KEYS[new Date(dayOf(at)).getUTCDay()]!];
  return `${clockLabel(at, zone)} ${day}`;
}

/**
 * The choice on one sold-out edit, as `until`. A tablet still running the old
 * page sends no choice, which means Rest of today.
 */
function soldOutUntil(e: Record<string, unknown>, ctx: SoldOutContext): { until: string | null } | { error: string } {
  const choice = e.sold_out_for ?? "rest_of_today";
  if (choice === "until_turned_back_on") return { until: null };
  if (choice === "rest_of_today") return { until: isoWithOffset(restOfTodayUntil(ctx.hours, ctx.now, ctx.zone), ctx.zone) };
  if (choice !== "back_at") return { error: "pick how long it is sold out" };
  if (e.back_day !== "today" && e.back_day !== "tomorrow") return { error: "pick today or tomorrow" };
  if (typeof e.back_time !== "string" || !HHMM.test(e.back_time)) return { error: "Pick a time" };
  const p = zonedParts(ctx.now, ctx.zone);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d) + (e.back_day === "tomorrow" ? 86_400_000 : 0));
  const at = zonedInstant(ctx.zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(e.back_time.slice(0, 2)), Number(e.back_time.slice(3, 5)));
  if (at <= ctx.now) return { error: "pick a time later than now" };
  return { until: isoWithOffset(at, ctx.zone) };
}

export function findMenuItem(menu: TabletMenu, ref: string): { item: TabletMenuItem; category: TabletMenuCategory } | null {
  for (const category of menu.categories) {
    const item = category.items.find((i) => i.ref === ref);
    if (item) return { item, category };
  }
  return null;
}

/** "24.99", "$24.99", "24" -> cents; null when it is not a price a kitchen would mean. */
export function parsePriceInput(raw: string): number | null {
  const m = raw.trim().replace(/^\$/, "").match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const c = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return c > 0 && c <= MAX_PRICE_CENTS ? c : null;
}

/**
 * Validate edits against the menu the tablet is showing. Each becomes one
 * line in the CRM parser's grammar (prs-crm src/lib/menu-sync/parser.ts,
 * RULES_GRAMMAR), naming the item by ref:
 *
 *   price #<ref> = 24.99       86 #<ref>       un-86 #<ref>
 *   rename #<ref> -> <new name>
 *
 * A ref that is not on this menu is refused: the kitchen is looking at a
 * menu the CRM has since replaced, and the tablet reloads it. A sold-out edit
 * also carries `until` beside its line; the line itself does not change.
 */
export function parseMenuEdits(input: unknown, menu: TabletMenu, ctx: SoldOutContext): MenuEditsDecision {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return { ok: false, error: "nothing to change" };
  if (list.length > MAX_EDITS) return { ok: false, error: `too many changes at once (${MAX_EDITS} max)` };
  const changes: MenuChangeRecord[] = [];
  for (const raw of list) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const ref = typeof e.ref === "string" ? e.ref : "";
    const found = findMenuItem(menu, ref);
    if (!found) return { ok: false, error: "that item isn't on the menu any more - the menu will reload" };
    const { item } = found;
    switch (e.action) {
      case "set_price": {
        const price = cents(e.price_cents);
        if (price === null || price <= 0 || price > MAX_PRICE_CENTS) return { ok: false, error: `${item.name}: enter a price between $0.01 and ${money(MAX_PRICE_CENTS)}` };
        if (price === item.price_cents) return { ok: false, error: `${item.name} is already ${money(price)}` };
        changes.push({ ref, action: "set_price", item: item.name, line: `price #${ref} = ${(price / 100).toFixed(2)}`, text: `${item.name}: ${money(item.price_cents)} to ${money(price)}` });
        break;
      }
      case "sold_out": {
        if (!item.available) return { ok: false, error: `${item.name} is already marked sold out` };
        const sold = soldOutUntil(e, ctx);
        if ("error" in sold) return { ok: false, error: `${item.name}: ${sold.error}` };
        const words = sold.until ? untilLabel(sold.until, ctx.now, ctx.zone) : "turned back on";
        changes.push({ ref, action: "sold_out", item: item.name, line: `86 #${ref}`, text: `${item.name}: sold out until ${words}`, until: sold.until });
        break;
      }
      case "back_on":
        if (item.available) return { ok: false, error: `${item.name} is already on the menu` };
        changes.push({ ref, action: "back_on", item: item.name, line: `un-86 #${ref}`, text: `${item.name}: back on the menu` });
        break;
      case "rename": {
        const name = str(e.name, MAX_NAME)?.replace(/->/g, "-") ?? null;
        if (!name) return { ok: false, error: `${item.name}: enter the new name` };
        if (name === item.name) return { ok: false, error: `${item.name} already has that name` };
        changes.push({ ref, action: "rename", item: item.name, line: `rename #${ref} -> ${name}`, text: `${item.name}: renamed to "${name}"` });
        break;
      }
      default:
        return { ok: false, error: "unknown change" };
    }
  }
  return {
    ok: true,
    body: changes.map((c) => c.text).join("\n"),
    menuChanges: { menu_id: menu.menu_id, lines: changes.map((c) => c.line), changes },
  };
}

/**
 * Items with a change sent since the menu was last pushed - shown as
 * "Sent to Premium" so nobody sends it twice. A push newer than the message
 * means the CRM has since published (or declined) it, and the item shows
 * whatever the CRM now says.
 */
export function pendingRefs(messages: { created_at: string; menu_changes: MenuChanges | null }[], pushedAt: string): Set<string> {
  const cutoff = Date.parse(pushedAt);
  const out = new Set<string>();
  for (const m of messages) {
    if (Date.parse(m.created_at) <= cutoff || !m.menu_changes) continue;
    for (const c of m.menu_changes.changes) out.add(c.ref);
  }
  return out;
}

/** The items whose name matches, keeping category order. Empty query = everything. */
export function filterMenu(menu: TabletMenu, query: string): TabletMenuCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) return menu.categories;
  return menu.categories.map((c) => ({ ...c, items: c.items.filter((i) => i.name.toLowerCase().includes(q)) })).filter((c) => c.items.length > 0);
}
