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

/** What a tap on the tablet may do to one item. */
export type MenuEdit =
  | { ref: string; action: "set_price"; price_cents: number }
  | { ref: string; action: "sold_out" }
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
}

export interface MenuChanges {
  menu_id: string;
  lines: string[];
  changes: MenuChangeRecord[];
}

export type MenuEditsDecision = { ok: true; body: string; menuChanges: MenuChanges } | { ok: false; error: string };

export const money = (c: number) => `$${(c / 100).toFixed(2)}`;

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
 * menu the CRM has since replaced, and the tablet reloads it.
 */
export function parseMenuEdits(input: unknown, menu: TabletMenu): MenuEditsDecision {
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
      case "sold_out":
        if (!item.available) return { ok: false, error: `${item.name} is already marked sold out` };
        changes.push({ ref, action: "sold_out", item: item.name, line: `86 #${ref}`, text: `${item.name}: sold out` });
        break;
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
