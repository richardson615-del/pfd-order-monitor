/**
 * PFD's touchscreen order box (2026-11-25, Matt: "build all of those
 * features including the nice to have"). The box prints through Server Direct
 * Print like an Eatabit (app/api/print/epson); everything its screen adds -
 * GOT IT, READY, running late, busy, pause, messages to dispatch, 86, deny an
 * Uber Eats order, today's numbers, the driver on the way, printer health,
 * remote commands and screenshots - goes through POST /api/print/box.
 *
 * Pure. The route and lib/orderbox-server.ts read and write; this decides what
 * a request may be and the exact text the box reads. The reply is key=value
 * lines, one per line, because the box parses it with a few lines of C and
 * has no JSON parser worth the flash. Values are ASCII with no newlines or
 * pipes: the box's fonts have nothing else, and a pipe splits fields.
 */

export const BOX_ACTIONS = [
  "Sync",
  "Ack",
  "Ready",
  "Late",
  "Prep",
  "Busy",
  "Pause",
  "Msg",
  "Read",
  "Menu",
  "Item86",
  "Deny",
  "Health",
  "Done",
  "Reprint",
  "Shot",
] as const;
export type BoxAction = (typeof BOX_ACTIONS)[number];
export const isBoxAction = (v: unknown): v is BoxAction => typeof v === "string" && (BOX_ACTIONS as readonly string[]).includes(v);

/** How many of today's orders a Sync carries. The box lists them newest first. */
export const SYNC_ORDER_LIMIT = 30;
/** Dispatch replies a Sync carries (newest first). */
export const SYNC_MESSAGE_LIMIT = 3;
/** Menu items a Menu reply carries. A bigger menu is cut, and the reply says so. */
export const MENU_ITEM_LIMIT = 400;
/** The largest screenshot body accepted (an RLE frame; a full raw 400x240 frame is 192 KB). */
export const MAX_SHOT_BYTES = 400_000;

// --- text the box can draw -----------------------------------------------------

const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"',
  "–": "-", "—": "-", "−": "-",
  "…": "...", " ": " ", "½": "1/2", "¼": "1/4", "¾": "3/4",
  "×": "x", "•": "*",
};

/** One field value: ASCII only, no newline, no pipe, trimmed and cut to `max`. */
export function boxText(v: unknown, max = 120): string {
  if (v == null) return "";
  let s = String(v);
  s = s.replace(/[‘-„–—−… ½¼¾×•]/g, (c) => FOLD[c] ?? "");
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/[|\r\n\t]/g, " ").replace(/[^\x20-\x7e]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "." : s;
}

/** Seconds since the epoch for the box (it has NTP), 0 for none. */
export function epochOf(at: string | null | undefined): number {
  if (!at) return 0;
  const t = Date.parse(at);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** The reply body: key=value lines. Arrays repeat the key, one line each. */
export function boxReply(pairs: Array<[string, string | number | boolean | null | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v === null ? "" : typeof v === "boolean" ? (v ? 1 : 0) : v}`)
    .join("\n") + "\n";
}

// --- the order list ------------------------------------------------------------

export interface BoxOrderRow {
  id: string;
  order_number: string | null;
  ticket_no: number | null;
  source: string | null;
  order_type: string | null;
  status: string;
  received_at: string;
  due_time: string | null;
  accepted_at: string | null;
  ready_by: string | null;
  ready_at: string | null;
  customer_name: string | null;
  items: unknown;
  driver_name: string | null;
  driver_status: string | null;
  driver_eta_at: string | null;
  kitchen_denied_at: string | null;
}

/** What the box shows as the order's number: the ticket number when there is one (059), else the order number. */
export const boxNumber = (o: Pick<BoxOrderRow, "ticket_no" | "order_number">): string =>
  o.ticket_no != null ? String(o.ticket_no) : (o.order_number ?? "?");

export const firstName = (name: string | null | undefined): string => boxText((name ?? "").trim().split(/\s+/)[0] ?? "", 20);

const itemCount = (items: unknown): number => (Array.isArray(items) ? items.length : 0);

/**
 * One `o=` line. Fields, in order:
 * id | number | source | type | status | accepted | ready_by | ready_at |
 * driver | driver_status | driver_eta | denied | customer | items | received | due
 * Times are epoch seconds, 0 for none. accepted / denied are 0 or 1.
 */
export function orderLine(o: BoxOrderRow): string {
  return [
    o.id,
    boxText(boxNumber(o), 16),
    boxText(o.source ?? "", 12),
    boxText(o.order_type ?? "", 12),
    boxText(o.status, 12),
    o.accepted_at ? 1 : 0,
    epochOf(o.ready_by),
    epochOf(o.ready_at),
    firstName(o.driver_name),
    boxText(o.driver_status ?? "", 12),
    epochOf(o.driver_eta_at),
    o.kitchen_denied_at ? 1 : 0,
    firstName(o.customer_name),
    itemCount(o.items),
    epochOf(o.received_at),
    epochOf(o.due_time),
  ].join("|");
}

// --- today's numbers -------------------------------------------------------------

export interface TodayRow {
  source: string | null;
  status: string;
  items_total: number | string | null;
  items: unknown;
}

export interface TodaySummary {
  orders: number;
  salesCents: number;
  topItem: string;
  avgCents: number;
}

const itemName = (raw: string): string => raw.replace(/^\s*\d+\s*[xX]\s+/, "").trim();

/** Today's orders, food sales (items_total, as on the tablet's Sales tab), the most-ordered item and the average ticket. Test and cancelled orders do not count. */
export function todaySummary(rows: TodayRow[]): TodaySummary {
  let orders = 0;
  let salesCents = 0;
  let priced = 0;
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.source === "test" || r.status === "cancelled") continue;
    orders++;
    const c = r.items_total == null || r.items_total === "" ? NaN : Math.round(Number(r.items_total) * 100);
    if (Number.isFinite(c)) {
      salesCents += c;
      priced++;
    }
    if (Array.isArray(r.items)) {
      for (const it of r.items as Array<{ name?: unknown }>) {
        const n = typeof it?.name === "string" ? itemName(it.name) : "";
        if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
      }
    }
  }
  let topItem = "";
  let best = 0;
  for (const [n, c] of counts) {
    if (c > best || (c === best && n < topItem)) {
      topItem = n;
      best = c;
    }
  }
  return { orders, salesCents, topItem: boxText(topItem, 40), avgCents: priced ? Math.round(salesCents / priced) : 0 };
}

// --- requests -------------------------------------------------------------------

export type DenyCode = "CAPACITY" | "ITEM_AVAILABILITY" | "STORE_CLOSED" | "OTHER";
export const DENY_CODES: readonly DenyCode[] = ["CAPACITY", "ITEM_AVAILABILITY", "STORE_CLOSED", "OTHER"];

/** The box's quick messages to dispatch. Each is a message kind the CRM already turns into a ticket (lib/messages.ts). */
export const BOX_MESSAGES = {
  wheres_driver: { kind: "driver_late", body: "Where's my driver? (from the order box)" },
  running_behind: { kind: "text", body: "We're running behind on orders. (from the order box)" },
  missing_item: { kind: "order_problem", body: "Missing an item on this order - please call us. (from the order box)" },
  customer_here: { kind: "text", body: "The customer is here for this order. (from the order box)" },
  call_me: { kind: "text", body: "Please call the restaurant. (from the order box)" },
} as const;
export type BoxMessageKey = keyof typeof BOX_MESSAGES;

export const PRINTER_STATUSES = ["ok", "paper_low", "paper_out", "cover_open", "offline"] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const BOX_COMMANDS = ["reboot", "screenshot", "reprint"] as const;
export type BoxCommand = (typeof BOX_COMMANDS)[number];

export type BoxRequest =
  | { action: "Sync" }
  | { action: "Ack"; orderId: string; minutes: number | null }
  | { action: "Ready"; orderId: string }
  | { action: "Late"; orderId: string; add: 5 | 10 }
  | { action: "Prep"; orderId: string; minutes: number }
  | { action: "Busy"; end: true } | { action: "Busy"; end: false; minutes: number; lengthMinutes: number }
  | { action: "Pause"; end: true } | { action: "Pause"; end: false; choice: "15" | "30" | "60" | "120" | "today" }
  | { action: "Msg"; key: BoxMessageKey; orderId: string | null }
  | { action: "Read" }
  | { action: "Menu" }
  | { action: "Item86"; ref: string; soldOut: boolean }
  | { action: "Deny"; orderId: string; code: DenyCode }
  | { action: "Health"; printer: PrinterStatus; link: "wifi" | "backup" | null }
  | { action: "Done"; command: string; result: string }
  | { action: "Reprint"; orderId: string }
  | { action: "Shot"; width: number; height: number };

export type BoxParse = { ok: true; req: BoxRequest } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-Za-z0-9._:-]{1,120}$/;
const int = (v: string | null): number | null => (v != null && /^\d{1,4}$/.test(v) ? Number(v) : null);

/** Parses one form post from the box. `form` is the urlencoded body (or the query string for Shot). */
export function parseBoxRequest(form: URLSearchParams): BoxParse {
  const action = form.get("Action") ?? "";
  if (!isBoxAction(action)) return { ok: false, error: "unknown action" };
  const order = () => {
    const id = (form.get("Order") ?? "").trim();
    return UUID.test(id) ? id : null;
  };
  const needOrder = () => {
    const id = order();
    return id ? id : null;
  };

  switch (action) {
    case "Sync":
    case "Read":
    case "Menu":
      return { ok: true, req: { action } };
    case "Ack": {
      const id = needOrder();
      if (!id) return { ok: false, error: "order required" };
      const m = form.get("Minutes");
      const minutes = m == null || m === "" ? null : int(m);
      if (minutes !== null && (minutes < 1 || minutes > 180)) return { ok: false, error: "minutes 1-180" };
      if (m != null && m !== "" && minutes === null) return { ok: false, error: "minutes 1-180" };
      return { ok: true, req: { action, orderId: id, minutes } };
    }
    case "Ready":
    case "Reprint": {
      const id = needOrder();
      return id ? { ok: true, req: { action, orderId: id } } : { ok: false, error: "order required" };
    }
    case "Late": {
      const id = needOrder();
      if (!id) return { ok: false, error: "order required" };
      const add = int(form.get("Add"));
      if (add !== 5 && add !== 10) return { ok: false, error: "add 5 or 10" };
      return { ok: true, req: { action, orderId: id, add } };
    }
    case "Prep": {
      const id = needOrder();
      if (!id) return { ok: false, error: "order required" };
      const minutes = int(form.get("Minutes"));
      if (minutes === null || minutes < 1 || minutes > 180) return { ok: false, error: "minutes 1-180" };
      return { ok: true, req: { action, orderId: id, minutes } };
    }
    case "Busy": {
      if (form.get("End") === "1") return { ok: true, req: { action, end: true } };
      const minutes = int(form.get("Add"));
      const lengthMinutes = int(form.get("For"));
      if (!minutes || !lengthMinutes) return { ok: false, error: "Add and For required" };
      return { ok: true, req: { action, end: false, minutes, lengthMinutes } };
    }
    case "Pause": {
      if (form.get("End") === "1") return { ok: true, req: { action, end: true } };
      const choice = form.get("For") ?? "";
      if (!["15", "30", "60", "120", "today"].includes(choice)) return { ok: false, error: "For 15, 30, 60, 120 or today" };
      return { ok: true, req: { action, end: false, choice: choice as "15" } };
    }
    case "Msg": {
      const key = form.get("Kind") ?? "";
      if (!(key in BOX_MESSAGES)) return { ok: false, error: "unknown message" };
      const raw = form.get("Order");
      const id = order();
      if (raw && !id) return { ok: false, error: "bad order" };
      return { ok: true, req: { action, key: key as BoxMessageKey, orderId: id } };
    }
    case "Item86": {
      const ref = (form.get("Ref") ?? "").trim();
      if (!REF.test(ref)) return { ok: false, error: "bad ref" };
      const on = form.get("Out");
      if (on !== "1" && on !== "0") return { ok: false, error: "Out 1 or 0" };
      return { ok: true, req: { action, ref, soldOut: on === "1" } };
    }
    case "Deny": {
      const id = needOrder();
      if (!id) return { ok: false, error: "order required" };
      const code = (form.get("Code") ?? "") as DenyCode;
      if (!DENY_CODES.includes(code)) return { ok: false, error: "bad code" };
      return { ok: true, req: { action, orderId: id, code } };
    }
    case "Health": {
      const printer = (form.get("Printer") ?? "") as PrinterStatus;
      if (!(PRINTER_STATUSES as readonly string[]).includes(printer)) return { ok: false, error: "bad printer status" };
      const l = form.get("Link");
      const link = l === "wifi" || l === "backup" ? l : null;
      return { ok: true, req: { action, printer, link } };
    }
    case "Done": {
      const command = boxText(form.get("Cmd"), 80);
      if (!command) return { ok: false, error: "Cmd required" };
      return { ok: true, req: { action, command, result: boxText(form.get("Result"), 200) } };
    }
    case "Shot": {
      const width = int(form.get("W"));
      const height = int(form.get("H"));
      if (!width || !height || width > 800 || height > 800) return { ok: false, error: "bad size" };
      return { ok: true, req: { action, width, height } };
    }
  }
}

// --- remote commands -------------------------------------------------------------

export type CommandParse = { ok: true; command: string } | { ok: false; error: string };

/** What the CRM may queue: reboot, screenshot, or reprint:<number> (the number the box shows). */
export function parseBoxCommand(input: { command?: unknown; order_number?: unknown }): CommandParse {
  const c = input.command;
  if (c === "reboot" || c === "screenshot") return { ok: true, command: c };
  if (c === "reprint") {
    const n = typeof input.order_number === "string" || typeof input.order_number === "number" ? String(input.order_number).trim() : "";
    if (!/^[A-Za-z0-9-]{1,24}$/.test(n)) return { ok: false, error: "order_number required for reprint" };
    return { ok: true, command: `reprint:${n}` };
  }
  return { ok: false, error: "command must be reboot, screenshot or reprint" };
}

/** A command is handed to the box once; one sent and not reported in 5 minutes is offered again. */
export const COMMAND_RESEND_MS = 5 * 60_000;
/** A command nobody picked up in a day is dropped. */
export const COMMAND_EXPIRE_MS = 24 * 60 * 60_000;

export function commandToSend(
  d: { box_command: string | null; box_command_at: string | null; box_command_sent_at: string | null; box_command_done_at: string | null },
  now: number
): string | null {
  if (!d.box_command || d.box_command_done_at) return null;
  const at = Date.parse(d.box_command_at ?? "");
  if (Number.isFinite(at) && now - at > COMMAND_EXPIRE_MS) return null;
  const sent = Date.parse(d.box_command_sent_at ?? "");
  if (Number.isFinite(sent) && now - sent < COMMAND_RESEND_MS) return null;
  return d.box_command;
}

// --- driver status from the CRM ---------------------------------------------------

export type DriverParse =
  | { ok: true; clear: true }
  | { ok: true; clear: false; name: string; status: "assigned" | "at_pickup" | "picked_up"; etaAt: string | null }
  | { ok: false; error: string };

/** POST /api/crm/orders/:id/actions { action: "driver", driver: { name, status, eta_at } | null }. */
export function parseDriverPush(input: unknown): DriverParse {
  if (input === null) return { ok: true, clear: true };
  const o = (input ?? {}) as Record<string, unknown>;
  const name = firstName(typeof o.name === "string" ? o.name : "");
  if (!name) return { ok: false, error: "driver.name required" };
  const status = o.status;
  if (status !== "assigned" && status !== "at_pickup" && status !== "picked_up") return { ok: false, error: "driver.status must be assigned, at_pickup or picked_up" };
  let etaAt: string | null = null;
  if (o.eta_at != null) {
    const t = typeof o.eta_at === "string" ? Date.parse(o.eta_at) : NaN;
    if (!Number.isFinite(t)) return { ok: false, error: "driver.eta_at must be an ISO time" };
    etaAt = new Date(t).toISOString();
  }
  return { ok: true, clear: false, name, status, etaAt };
}

// --- screenshots -------------------------------------------------------------------

/**
 * The box sends its screen at half size as run-length RGB565: repeated
 * [count u8][color u16 little-endian], count 1-255. Decodes to RGBA for the
 * PNG. Throws on a frame that does not fill width x height exactly.
 */
export function decodeShot(body: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  let px = 0;
  if (body.length % 3 !== 0) throw new Error("frame length is not a whole number of runs");
  for (let i = 0; i < body.length; i += 3) {
    const n = body[i];
    if (n === 0) throw new Error("zero-length run");
    const c = body[i + 1] | (body[i + 2] << 8);
    const r = ((c >> 11) & 0x1f) * 255 / 31;
    const g = ((c >> 5) & 0x3f) * 255 / 63;
    const b = (c & 0x1f) * 255 / 31;
    if (px + n > total) throw new Error("frame is larger than its size");
    for (let k = 0; k < n; k++) {
      const o = (px + k) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
    px += n;
  }
  if (px !== total) throw new Error(`frame is ${px} pixels, expected ${total}`);
  return out;
}

/** The encoder the box runs, here so the tests can round-trip a frame. */
export function encodeShot(pixels: Uint16Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < pixels.length) {
    const c = pixels[i];
    let n = 1;
    while (n < 255 && i + n < pixels.length && pixels[i + n] === c) n++;
    out.push(n, c & 0xff, c >> 8);
    i += n;
  }
  return Uint8Array.from(out);
}

// --- health ----------------------------------------------------------------------

/** The printer's own words for the kitchen and the CRM. Null when nothing is wrong. */
export function printerStatusText(s: string | null | undefined): string | null {
  switch (s) {
    case "paper_low": return "Paper is running low";
    case "paper_out": return "Out of paper";
    case "cover_open": return "Printer cover is open";
    case "offline": return "Printer is not answering";
    default: return null;
  }
}

/** The order box names itself in printer_name ("PFD Eatabit 1.1.0 Order Box"), so a CRM reader and health can tell it apart. */
export const ORDER_BOX_SUFFIX = "Order Box";
export const isOrderBoxPrinterName = (n: string | null | undefined): boolean => (n ?? "").endsWith(ORDER_BOX_SUFFIX);
