import { createCanvas } from "@napi-rs/canvas";
import { supabaseAdmin } from "./supabase-server";
import { DEFAULT_ZONE } from "./store-session";
import { prepMinutesOf } from "./countdown";
import { isScheduled } from "./order-display";
import { readyByFor, refuseReadyChange, runningLateMinutes } from "./ready-timer";
import { BUSY_SELECT, COOK_LIMIT_SELECT, acceptMinutes, boostStartLog, busyEndsAt, cookLimitsOf, liveBusy, nextCloseAt, parseBusyRequest, runningLateLog } from "./cook-time";
import { endBusy, recordCookTimeChange, sweepExpiredBusy } from "./cook-time-data";
import { PAUSE_RATE_LIMIT, livePause, parsePause, pauseMessageBody } from "./store";
import { RATE_WINDOW_MS, overRateLimit } from "./messages";
import { parseMenuEdits, pendingRefs, type TabletMenu } from "./menu-editor";
import { localDayKey } from "./local-day";
import { queueOrderToPrinters } from "./print-queue";
import {
  BOX_MESSAGES,
  MENU_ITEM_LIMIT,
  SYNC_MESSAGE_LIMIT,
  SYNC_ORDER_LIMIT,
  boxReply,
  boxText,
  commandToSend,
  decodeShot,
  epochOf,
  orderLine,
  todaySummary,
  type BoxOrderRow,
  type BoxRequest,
} from "./orderbox";

/**
 * The order box's side of the bridge (lib/orderbox.ts has the rules). Every
 * handler takes the device the key belongs to and works only on that
 * device's restaurant: an order id from the box is checked against it, so a
 * box can never touch another restaurant's order.
 *
 * Each answers { status, body } with a key=value body. ok=1 or ok=0 always
 * comes first; error= carries words the box can show as they are.
 */

export interface BoxDevice {
  id: string;
  restaurant_id: string;
  box_command: string | null;
  box_command_at: string | null;
  box_command_sent_at: string | null;
  box_command_done_at: string | null;
}

export interface BoxResult {
  status: number;
  body: string;
}

// The database and the print queue, swappable so scripts/test-orderbox.ts can
// run every handler against an in-memory database. Nothing else sets them.
let adminOf: () => ReturnType<typeof supabaseAdmin> = supabaseAdmin;
let queuePrint: typeof queueOrderToPrinters = queueOrderToPrinters;
export function useBoxBackendForTests(admin: () => any, queue?: typeof queueOrderToPrinters) {
  adminOf = admin;
  if (queue) queuePrint = queue;
}

const ACTOR = "Order box";
const WHO = { source: "tablet" as const, actor: ACTOR };
const BOX_ORDER_SELECT =
  "id, order_number, ticket_no, source, order_type, status, received_at, due_time, accepted_at, ready_minutes, ready_by, ready_at, customer_name, items, items_total, driver_name, driver_status, driver_eta_at, kitchen_denied_at, restaurant_id";

const ok = (pairs: Array<[string, string | number | boolean | null | undefined]> = []): BoxResult => ({ status: 200, body: boxReply([["ok", 1], ...pairs]) });
const fail = (status: number, error: string): BoxResult => ({ status, body: boxReply([["ok", 0], ["error", boxText(error, 120)]]) });

export async function findBoxDevice(deviceKey: string): Promise<BoxDevice | null> {
  if (!deviceKey) return null;
  const { data } = await adminOf()
    .from("print_devices")
    .select("id, restaurant_id, box_command, box_command_at, box_command_sent_at, box_command_done_at")
    .eq("device_key", deviceKey)
    .eq("is_active", true)
    .maybeSingle();
  return (data as BoxDevice | null) ?? null;
}

async function boxOrder(device: BoxDevice, orderId: string) {
  const { data } = await adminOf().from("orders").select(BOX_ORDER_SELECT).eq("id", orderId).eq("restaurant_id", device.restaurant_id).maybeSingle();
  return data as (BoxOrderRow & { ready_minutes: number | null; restaurant_id: string; items_total: unknown }) | null;
}

async function restaurantOf(device: BoxDevice) {
  const { data, error } = await adminOf()
    .from("restaurants")
    .select(`id, name, timezone, prep_minutes, box_promo, online_paused_until, online_pause_reason, online_paused_at, ${BUSY_SELECT}, ${COOK_LIMIT_SELECT}`)
    .eq("id", device.restaurant_id)
    .single();
  if (error) throw new Error(error.message);
  return data as any;
}

// --- Sync ------------------------------------------------------------------------

export async function boxSync(device: BoxDevice, now = Date.now()): Promise<BoxResult> {
  const admin = adminOf();
  const r = await restaurantOf(device);
  const zone = r.timezone ?? DEFAULT_ZONE;
  const since = new Date(now - 30 * 60 * 60_000).toISOString();

  const [ordersRes, msgRes, unreadRes] = await Promise.all([
    admin.from("orders").select(BOX_ORDER_SELECT).eq("restaurant_id", device.restaurant_id).gte("received_at", since).neq("source", "test").order("received_at", { ascending: false }).limit(200),
    admin
      .from("restaurant_messages")
      .select("body, author, created_at, read_at")
      .eq("restaurant_id", device.restaurant_id)
      .eq("direction", "to_restaurant")
      .order("created_at", { ascending: false })
      .limit(SYNC_MESSAGE_LIMIT),
    admin.from("restaurant_messages").select("id", { count: "exact", head: true }).eq("restaurant_id", device.restaurant_id).eq("direction", "to_restaurant").is("read_at", null),
  ]);
  if (ordersRes.error) return fail(500, "Could not read orders");

  const today = localDayKey(now, zone);
  const todays = (ordersRes.data ?? []).filter((o: any) => localDayKey(o.received_at, zone) === today);
  const summary = todaySummary(todays as any);
  const busy = liveBusy(r, now);
  const pause = livePause(r, new Date(now));
  const command = commandToSend(device, now);

  const pairs: Array<[string, string | number | boolean | null | undefined]> = [
    ["now", Math.floor(now / 1000)],
    ["name", boxText(r.name, 40)],
    ["prep", acceptMinutes(prepMinutesOf(r.prep_minutes), busy)],
    ["busy", busy ? `${busy.minutes}|${epochOf(busy.until)}` : "0"],
    ["paused", pause ? `${epochOf(pause.until)}|${boxText(pause.reason ?? "", 60)}` : "0"],
    ["unread", unreadRes.count ?? 0],
    ["today", `${summary.orders}|${summary.salesCents}|${summary.avgCents}|${summary.topItem}`],
    ["promo", boxText(r.box_promo ?? "", 120)],
  ];
  if (command) pairs.push(["cmd", command]);
  for (const m of msgRes.data ?? []) pairs.push(["msg", `${epochOf(m.created_at)}|${m.read_at ? 1 : 0}|${boxText(m.author ?? "PFD", 24)}|${boxText(m.body, 160)}`]);
  // Today's orders, newest first; an older order still open in the kitchen (past midnight) stays on.
  const live = (ordersRes.data ?? []).filter((o: any) => localDayKey(o.received_at, zone) === today || !["completed", "cancelled"].includes(o.status));
  for (const o of live.slice(0, SYNC_ORDER_LIMIT)) pairs.push(["o", orderLine(o as BoxOrderRow)]);

  if (command) {
    await admin.from("print_devices").update({ box_command_sent_at: new Date(now).toISOString() }).eq("id", device.id).eq("box_command", command);
  }
  return ok(pairs);
}

// --- order actions --------------------------------------------------------------------

/** GOT IT / ACCEPT: the tablet's Accept. Minutes default to the restaurant's prep target plus any busy boost. */
export async function boxAck(device: BoxDevice, orderId: string, minutes: number | null): Promise<BoxResult> {
  const order = await boxOrder(device, orderId);
  if (!order) return fail(404, "Order not found");
  if (order.status === "cancelled") return fail(409, "That order was cancelled");
  if (order.accepted_at) return ok([["already", 1], ["ready_by", epochOf(order.ready_by)]]);
  const now = new Date().toISOString();
  let readyBy: string | null;
  let m: number | null = minutes;
  if (isScheduled(order as any, Date.now())) {
    m = null;
    readyBy = order.due_time ? new Date(order.due_time).toISOString() : null;
  } else {
    if (m === null) {
      const r = await restaurantOf(device);
      m = acceptMinutes(prepMinutesOf(r.prep_minutes), liveBusy(r, Date.now()));
    }
    readyBy = readyByFor(now, m);
  }
  const { data, error } = await adminOf()
    .from("orders")
    .update({ accepted_at: now, ready_minutes: m, ready_by: readyBy })
    .eq("id", order.id)
    .is("accepted_at", null)
    .select("ready_by")
    .maybeSingle();
  if (error) return fail(500, "Could not save");
  return ok([["ready_by", epochOf(data?.ready_by ?? readyBy)]]);
}

/** READY: the food is on the pass. Stamped once; accepts the order too when nobody had. */
export async function boxReady(device: BoxDevice, orderId: string): Promise<BoxResult> {
  const order = await boxOrder(device, orderId);
  if (!order) return fail(404, "Order not found");
  if (order.ready_at) return ok([["already", 1]]);
  const refused = refuseReadyChange(order as any, "ready");
  if (refused) return fail(409, refused.error);
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { ready_at: now };
  if (!order.accepted_at) update.accepted_at = now;
  const { error } = await adminOf().from("orders").update(update).eq("id", order.id).is("ready_at", null);
  if (error) return fail(500, "Could not save");
  return ok();
}

/** Running late +5 / +10, the tablet's button. */
export async function boxLate(device: BoxDevice, orderId: string, add: number): Promise<BoxResult> {
  const order = await boxOrder(device, orderId);
  if (!order) return fail(404, "Order not found");
  const refused = refuseReadyChange(order as any, "retime");
  if (refused) return fail(409, refused.error);
  const r = await restaurantOf(device);
  const minutes = runningLateMinutes(order, add, prepMinutesOf(r.prep_minutes), Date.now());
  if (minutes === null) return fail(409, "Can't add more time to this order");
  return retime(device, order, minutes);
}

/** A prep time picked on the box: accepts with it, or re-times an accepted order. */
export async function boxPrep(device: BoxDevice, orderId: string, minutes: number): Promise<BoxResult> {
  const order = await boxOrder(device, orderId);
  if (!order) return fail(404, "Order not found");
  if (!order.accepted_at) return boxAck(device, orderId, minutes);
  const refused = refuseReadyChange(order as any, "retime");
  if (refused) return fail(409, refused.error);
  return retime(device, order, minutes);
}

async function retime(device: BoxDevice, order: NonNullable<Awaited<ReturnType<typeof boxOrder>>>, minutes: number): Promise<BoxResult> {
  const admin = adminOf();
  const { data, error } = await admin
    .from("orders")
    .update({ ready_minutes: minutes, ready_by: readyByFor(order.accepted_at, minutes) })
    .eq("id", order.id)
    .is("ready_at", null)
    .select("ready_by")
    .maybeSingle();
  if (error || !data) return fail(409, "Could not change the time");
  await recordCookTimeChange(admin, runningLateLog({ id: order.id, restaurant_id: device.restaurant_id, order_number: order.order_number, ready_by: order.ready_by }, data.ready_by, WHO));
  return ok([["ready_by", epochOf(data.ready_by)]]);
}

/** Deny an Uber Eats order. The CRM reads kitchen_denied_at from the feed and refuses it with Uber. */
export async function boxDeny(device: BoxDevice, orderId: string, code: string): Promise<BoxResult> {
  const order = await boxOrder(device, orderId);
  if (!order) return fail(404, "Order not found");
  if (order.source !== "ubereats") return fail(409, "Only Uber Eats orders can be denied here. Call dispatch.");
  if (order.accepted_at) return fail(409, "Already accepted - call dispatch to cancel");
  if (order.status === "cancelled") return ok([["already", 1]]);
  const { error } = await adminOf()
    .from("orders")
    .update({ kitchen_denied_at: new Date().toISOString(), kitchen_deny_code: code })
    .eq("id", order.id)
    .is("accepted_at", null)
    .is("kitchen_denied_at", null);
  if (error) return fail(500, "Could not save");
  return ok();
}

/** Print it again from the server (the box reprints from its own copy first; this is for an order it never printed). */
export async function boxReprint(device: BoxDevice, orderId: string): Promise<BoxResult> {
  const order = await boxOrder(device, orderId);
  if (!order) return fail(404, "Order not found");
  const res = await queuePrint(order.id, device.restaurant_id, { queuedBy: "reprint:orderbox", receivedAt: order.received_at });
  if (res.refusal) return fail(409, res.message ?? "Could not reprint");
  return ok([["queued", res.queued.length]]);
}

// --- the restaurant -------------------------------------------------------------------

export async function boxBusy(device: BoxDevice, req: Extract<BoxRequest, { action: "Busy" }>): Promise<BoxResult> {
  const admin = adminOf();
  await sweepExpiredBusy(admin).catch(() => 0);
  const r = await restaurantOf(device);
  if (req.end) {
    const ended = await endBusy(admin, r, WHO);
    if (ended.error) return fail(500, "Could not save");
    return ok([["busy", "0"]]);
  }
  const want = req as { minutes: number; lengthMinutes: number };
  const d = parseBusyRequest({ minutes: want.minutes, length_minutes: want.lengthMinutes }, cookLimitsOf(r));
  if (d.kind === "error") return fail(400, d.error);
  if (d.kind === "end") return ok();
  const now = new Date();
  if (liveBusy(r, now.getTime())) return fail(409, "Busy is already on. End it first.");
  const { data: profile } = await admin.from("restaurant_profiles").select("hours").eq("restaurant_id", device.restaurant_id).maybeSingle();
  const until = busyEndsAt(now, d.lengthMinutes, nextCloseAt(profile?.hours, now, r.timezone ?? DEFAULT_ZONE)).toISOString();
  const { data: started, error } = await admin
    .from("restaurants")
    .update({ busy_boost_minutes: d.minutes, busy_started_at: now.toISOString(), busy_until: until, busy_started_by: ACTOR })
    .eq("id", device.restaurant_id)
    .is("busy_until", null)
    .select("id");
  if (error) return fail(500, "Could not save");
  if (!started?.length) return fail(409, "Busy is already on. End it first.");
  await recordCookTimeChange(admin, boostStartLog(device.restaurant_id, prepMinutesOf(r.prep_minutes), d.minutes, until, WHO));
  return ok([["busy", `${d.minutes}|${epochOf(until)}`]]);
}

export async function boxPause(device: BoxDevice, req: Extract<BoxRequest, { action: "Pause" }>): Promise<BoxResult> {
  const admin = adminOf();
  const now = new Date();
  const r = await restaurantOf(device);
  const zone = r.timezone ?? DEFAULT_ZONE;
  const d = parsePause(req.end ? { resume: true } : { choice: (req as { choice: string }).choice, reason: "Paused on the order box" }, now, zone);
  if (d.kind === "error") return fail(400, d.error);
  if (d.kind === "resume" && !livePause(r, now)) return ok([["paused", "0"]]);
  const { count } = await admin
    .from("restaurant_messages")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", device.restaurant_id)
    .eq("kind", "pause")
    .gte("created_at", new Date(now.getTime() - RATE_WINDOW_MS).toISOString());
  if ((count ?? 0) >= PAUSE_RATE_LIMIT) return fail(429, "Too many pause changes. Call dispatch.");
  const cols =
    d.kind === "resume"
      ? { online_paused_until: null, online_pause_reason: null, online_paused_at: null }
      : { online_paused_until: d.until.toISOString(), online_pause_reason: d.reason, online_paused_at: now.toISOString() };
  const { error } = await admin.from("restaurants").update(cols).eq("id", device.restaurant_id);
  if (error) return fail(500, "Could not save");
  // The same `pause` message the tablet writes: the CRM stops web, Muse and phone orders and pauses Uber from it.
  const { error: msgErr } = await admin.from("restaurant_messages").insert({
    restaurant_id: device.restaurant_id,
    direction: "from_restaurant",
    kind: "pause",
    body: pauseMessageBody(d, zone),
    author: ACTOR,
    details: d.kind === "resume" ? { paused_until: null, reason: null } : { paused_until: d.until.toISOString(), reason: d.reason },
  });
  if (msgErr) return fail(500, "Paused, but dispatch was not told. Call dispatch.");
  return ok([["paused", d.kind === "resume" ? "0" : `${epochOf(d.until.toISOString())}|${boxText(d.reason ?? "", 60)}`]]);
}

async function overLimit(device: BoxDevice): Promise<boolean> {
  const now = Date.now();
  const { data } = await adminOf()
    .from("restaurant_messages")
    .select("created_at")
    .eq("restaurant_id", device.restaurant_id)
    .eq("direction", "from_restaurant")
    .gte("created_at", new Date(now - RATE_WINDOW_MS).toISOString());
  return overRateLimit((data ?? []).map((r) => r.created_at as string), now);
}

export async function boxMessage(device: BoxDevice, key: keyof typeof BOX_MESSAGES, orderId: string | null): Promise<BoxResult> {
  if (orderId && !(await boxOrder(device, orderId))) return fail(404, "Order not found");
  if (await overLimit(device)) return fail(429, "Too many messages. Call dispatch if it's urgent.");
  const m = BOX_MESSAGES[key];
  const { error } = await adminOf()
    .from("restaurant_messages")
    .insert({ restaurant_id: device.restaurant_id, direction: "from_restaurant", kind: m.kind, body: m.body, order_id: orderId, author: ACTOR });
  if (error) return fail(500, "Could not send");
  return ok();
}

/** The box showed dispatch's replies: mark them read, as the tablet does. */
export async function boxRead(device: BoxDevice): Promise<BoxResult> {
  await adminOf()
    .from("restaurant_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("restaurant_id", device.restaurant_id)
    .eq("direction", "to_restaurant")
    .is("read_at", null);
  return ok();
}

// --- 86 ------------------------------------------------------------------------------

async function tabletMenu(device: BoxDevice): Promise<{ menu: TabletMenu; pushedAt: string } | null> {
  const { data } = await adminOf().from("restaurant_menus").select("crm_menu_id, source, menu, pushed_at").eq("restaurant_id", device.restaurant_id).maybeSingle();
  if (!data) return null;
  return {
    menu: { menu_id: data.crm_menu_id, source: data.source, categories: (data.menu as { categories?: TabletMenu["categories"] })?.categories ?? [] },
    pushedAt: data.pushed_at,
  };
}

/** The menu for the 86 screen: `cat=` lines, then `item=ref|available|pending|name` under each. */
export async function boxMenu(device: BoxDevice): Promise<BoxResult> {
  const m = await tabletMenu(device);
  if (!m) return ok([["menu", 0]]);
  const { data: msgs } = await adminOf()
    .from("restaurant_messages")
    .select("created_at, menu_changes")
    .eq("restaurant_id", device.restaurant_id)
    .eq("kind", "menu_change")
    .gte("created_at", m.pushedAt);
  const pending = pendingRefs((msgs ?? []) as any, m.pushedAt);
  const pairs: Array<[string, string | number]> = [["menu", 1]];
  let n = 0;
  let cut = false;
  for (const c of m.menu.categories) {
    if (n >= MENU_ITEM_LIMIT) {
      cut = true;
      break;
    }
    pairs.push(["cat", boxText(c.name, 40)]);
    for (const it of c.items) {
      if (n++ >= MENU_ITEM_LIMIT) {
        cut = true;
        break;
      }
      pairs.push(["item", `${it.ref}|${it.available ? 1 : 0}|${pending.has(it.ref) ? 1 : 0}|${boxText(it.name, 48)}`]);
    }
  }
  if (cut) pairs.push(["cut", 1]);
  return ok(pairs);
}

/** Sold out for the rest of today, or back on: the Menu tab's change, sent to dispatch the same way. */
export async function boxItem86(device: BoxDevice, ref: string, soldOut: boolean): Promise<BoxResult> {
  const admin = adminOf();
  const m = await tabletMenu(device);
  if (!m) return fail(409, "No menu on file yet. Call dispatch.");
  const [restaurant, profile] = await Promise.all([
    admin.from("restaurants").select("timezone").eq("id", device.restaurant_id).single(),
    admin.from("restaurant_profiles").select("hours").eq("restaurant_id", device.restaurant_id).maybeSingle(),
  ]);
  const edits = soldOut ? [{ ref, action: "sold_out", sold_out_for: "rest_of_today" }] : [{ ref, action: "back_on" }];
  const parsed = parseMenuEdits(edits, m.menu, { now: new Date(), zone: restaurant.data?.timezone ?? DEFAULT_ZONE, hours: profile.data?.hours });
  if ("error" in parsed) return fail(400, parsed.error);
  if (await overLimit(device)) return fail(429, "Too many changes. Call dispatch if it's urgent.");
  const { error } = await admin
    .from("restaurant_messages")
    .insert({ restaurant_id: device.restaurant_id, direction: "from_restaurant", kind: "menu_change", body: parsed.body, menu_changes: parsed.menuChanges, author: ACTOR });
  if (error) return fail(500, "Could not send");
  return ok();
}

// --- the box itself ------------------------------------------------------------------

export async function boxHealth(device: BoxDevice, printer: string, link: string | null): Promise<BoxResult> {
  const update: Record<string, unknown> = { printer_status: printer, printer_status_at: new Date().toISOString() };
  if (link) update.box_link = link;
  const { error } = await adminOf().from("print_devices").update(update).eq("id", device.id);
  if (error) return fail(500, "Could not save");
  return ok();
}

export async function boxDone(device: BoxDevice, command: string, result: string): Promise<BoxResult> {
  await adminOf()
    .from("print_devices")
    .update({ box_command_done_at: new Date().toISOString(), box_command_result: result || "done" })
    .eq("id", device.id)
    .eq("box_command", command)
    .is("box_command_done_at", null);
  return ok();
}

/** Encodes RGBA pixels as PNG. */
export function pngOf(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer("image/png");
}

export async function boxShot(device: BoxDevice, body: Uint8Array, width: number, height: number): Promise<BoxResult> {
  let png: Buffer;
  try {
    png = pngOf(decodeShot(body, width, height), width, height);
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : "bad frame");
  }
  const { error } = await adminOf()
    .from("device_screens")
    .upsert({ device_id: device.id, png: `\\x${png.toString("hex")}`, width, height, taken_at: new Date().toISOString() });
  if (error) return fail(500, "Could not save");
  return ok([["bytes", png.length]]);
}

// --- the driver, from the CRM ------------------------------------------------------

/** The CRM's "driver" action (lib/orderbox.ts parseDriverPush). Writes only when something changed. */
export async function setOrderDriver(
  orderId: string,
  d: { clear: boolean; name?: string; status?: string; etaAt?: string | null }
): Promise<{ changed: boolean; error?: string }> {
  const cols = d.clear
    ? { driver_name: null, driver_status: null, driver_eta_at: null }
    : { driver_name: d.name ?? null, driver_status: d.status ?? null, driver_eta_at: d.etaAt ?? null };
  const admin = adminOf();
  const { data: cur } = await admin.from("orders").select("driver_name, driver_status, driver_eta_at").eq("id", orderId).maybeSingle();
  const sameEta = (cur?.driver_eta_at ?? null) === null ? cols.driver_eta_at === null : Date.parse(cur!.driver_eta_at) === Date.parse(cols.driver_eta_at ?? "");
  if (cur && (cur.driver_name ?? null) === cols.driver_name && (cur.driver_status ?? null) === cols.driver_status && sameEta) return { changed: false };
  const { error } = await admin.from("orders").update({ ...cols, driver_updated_at: new Date().toISOString() }).eq("id", orderId);
  return error ? { changed: false, error: error.message } : { changed: true };
}
