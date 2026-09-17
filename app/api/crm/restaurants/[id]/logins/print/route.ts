import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { restaurantRefFilter } from "@/lib/restaurant-ref";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { publicBase } from "@/lib/footer-engine";
import { buildLoginTicket } from "@/lib/print-document";
import {
  MIN_PASSWORD_LENGTH,
  generatePassword,
  normaliseUsername,
  usernameToEmail,
} from "@/lib/usernames";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id/logins/print
 *
 *   { username, mode: "existing" | "reset", device_id?, actor, include_setup_steps? }
 *
 * Prints a restaurant's tablet login on that restaurant's own Epson.
 *
 * The problem this solves is not a missing feature, it is a channel: the CRM
 * could already create a login, reset one, and show a password on screen, and
 * then somebody had to carry it to the restaurant - in practice by reading it
 * down the phone to a kitchen during service. This puts it on the printer
 * already sitting in that kitchen, so the person who has to type it is the
 * person holding it.
 *
 * It is NOT a general print endpoint. The lines are composed here, from a
 * login this route has already proved belongs to this restaurant, on a device
 * it has already proved belongs to the same one. Nothing the caller sends is
 * printed verbatim except the username it named.
 *
 * Errors carry a `code` as well as a message, because the CRM needs to tell
 * the two interesting refusals apart and offer a different button for each:
 * `password_unavailable` means "issue a new password instead", and
 * `no_active_printer` means "there is no printer here yet".
 */

type ErrorCode =
  | "login_not_found"
  | "password_unavailable"
  | "no_active_printer"
  | "device_not_for_restaurant"
  | "device_inactive"
  | "printer_not_supported"
  | "restaurant_not_found"
  | "bad_request";

const fail = (code: ErrorCode, error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, code, ...extra }, { status });

/**
 * The transport a document job can actually be printed by.
 *
 * `app_version` is what a device reports when it checks in; the Epson's own
 * poll stamps it "server-direct-print". The older LAN/USB pull agent renders
 * a ticket from the order JSON this endpoint hands it, and knows nothing
 * about documents - so queueing one to such a device would leave a job that
 * is claimed, never printed, and reported to nobody. Null means it has never
 * checked in at all, which is allowed: it will queue and print when it does.
 */
const SERVER_DIRECT_PRINT = "server-direct-print";

async function audit(entry: {
  restaurantId: string;
  username: string;
  action: "password_printed" | "password_reset";
  actor: string | null;
  note?: string;
}) {
  // Never blocks the print, same judgement as the logins route's own audit:
  // an unwritable audit row is worth shouting about, not worth leaving
  // somebody at a restaurant unable to sign in.
  try {
    const { error } = await supabaseAdmin().from("restaurant_login_audit").insert({
      restaurant_id: entry.restaurantId,
      username: entry.username,
      action: entry.action,
      actor: entry.actor,
      note: entry.note ?? null,
    });
    if (error) console.error("login audit NOT recorded", entry.action, entry.username, "-", error.message);
  } catch (err) {
    console.error(
      "login audit NOT recorded", entry.action, entry.username, "-",
      err instanceof Error ? err.message : err
    );
  }
}

/** The link row for one username within one restaurant, or null. Same scoping rule as the logins route: a restaurant-scoped call must never act on somebody else's login because the username was spelled right. */
async function findLink(restaurantId: string, username: string) {
  const admin = supabaseAdmin();
  const email = usernameToEmail(username);

  const { data: links } = await admin
    .from("restaurant_users")
    .select("auth_user_id, password_current")
    .eq("restaurant_id", restaurantId);

  for (const link of links ?? []) {
    const { data } = await admin.auth.admin.getUserById(link.auth_user_id);
    if (data?.user?.email === email) return link;
  }
  return null;
}

/**
 * Which printer the ticket goes to.
 *
 * An explicit device_id wins, and is checked against the restaurant. With no
 * device_id: the restaurant's active printers, most recently seen first. Most
 * sites have exactly one; where there are two, the one that has checked in
 * most recently is the one currently plugged in, which is the only defensible
 * guess. The CRM offers the choice up front rather than relying on it.
 */
interface ChosenDevice {
  id: string;
  name: string;
  restaurant_id: string;
  is_active: boolean;
  app_version: string | null;
  last_seen_at: string | null;
}

const DEVICE_COLUMNS = "id, name, restaurant_id, is_active, app_version, last_seen_at";

type DeviceChoice =
  | { error: ErrorCode; message: string }
  | { device: ChosenDevice; alternatives: number };

async function chooseDevice(restaurantId: string, deviceId: string | null): Promise<DeviceChoice> {
  const admin = supabaseAdmin();

  if (deviceId) {
    const { data } = await admin
      .from("print_devices")
      .select(DEVICE_COLUMNS)
      .eq("id", deviceId)
      .maybeSingle();
    const device = data as ChosenDevice | null;
    if (!device) return { error: "device_not_for_restaurant", message: "that printer does not exist" };
    if (device.restaurant_id !== restaurantId) {
      return {
        error: "device_not_for_restaurant",
        message: "that printer belongs to a different restaurant",
      };
    }
    if (!device.is_active) {
      return {
        error: "device_inactive",
        message:
          "that printer is deactivated - its poll is rejected while inactive, so the ticket would queue forever. Activate it first.",
      };
    }
    return { device, alternatives: 0 };
  }

  const { data } = await admin
    .from("print_devices")
    .select(DEVICE_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .eq("is_active", true)
    .order("last_seen_at", { ascending: false, nullsFirst: false });

  const devices = (data ?? []) as ChosenDevice[];
  const device = devices[0];
  if (!device) {
    return {
      error: "no_active_printer",
      message: "this restaurant has no active printer to print to",
    };
  }
  return { device, alternatives: devices.length - 1 };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const username = normaliseUsername(body?.username ?? "");
  const mode = body?.mode === "reset" ? "reset" : "existing";
  const deviceId = typeof body?.device_id === "string" && body.device_id ? body.device_id : null;
  const actor =
    typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;
  const includeSetupSteps = body?.include_setup_steps !== false;

  if (!username) return fail("bad_request", "username is required", 400);

  const admin = supabaseAdmin();
  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .or(restaurantRefFilter(params.id) ?? "id.eq.00000000-0000-0000-0000-000000000000")
    .limit(1)
    .maybeSingle();
  if (!restaurant) return fail("restaurant_not_found", "restaurant not found", 404);

  const link = await findLink(restaurant.id, username);
  if (!link) {
    return fail("login_not_found", `"${username}" is not a login for ${restaurant.name}`, 404);
  }

  // The printer is chosen BEFORE the password is touched. Rotating a password
  // and then discovering there is nowhere to print it leaves a restaurant
  // locked out with the new one on a screen in another state.
  const chosen = await chooseDevice(restaurant.id, deviceId);
  if ("error" in chosen) {
    return fail(chosen.error, chosen.message, chosen.error === "no_active_printer" ? 409 : 400);
  }
  const device = chosen.device;

  if (device.app_version && device.app_version !== SERVER_DIRECT_PRINT) {
    return fail(
      "printer_not_supported",
      `${device.name} prints through the on-site agent, which only renders orders. A login ticket can only be sent to a printer on Server Direct Print.`,
      409
    );
  }

  let password: string | null = null;

  if (mode === "reset") {
    const fresh = generatePassword((n) => Uint8Array.from(randomBytes(n)));
    if (fresh.length < MIN_PASSWORD_LENGTH) {
      return fail("bad_request", `password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
    }
    const { error } = await admin.auth.admin.updateUserById(link.auth_user_id, { password: fresh });
    if (error) return fail("bad_request", error.message, 400);

    // Only after Supabase accepted it - storing first would leave the CRM
    // able to show a password that does not work.
    const { error: storeError } = await admin
      .from("restaurant_users")
      .update({ password_current: fresh, password_set_at: new Date().toISOString() })
      .eq("restaurant_id", restaurant.id)
      .eq("auth_user_id", link.auth_user_id);
    if (storeError) console.error("login password not stored for", username, "-", storeError.message);

    await audit({
      restaurantId: restaurant.id,
      username,
      action: "password_reset",
      actor,
      note: `password reset for ${restaurant.name}, to be printed on ${device.name}`,
    });
    password = fresh;
  } else {
    if (!link.password_current) {
      // Created before migration 026: the only copy is Supabase's hash, so
      // there is nothing to print. Distinguished by code so the CRM can offer
      // "new password" rather than reporting a failure.
      return fail(
        "password_unavailable",
        `"${username}" was created before passwords were kept, so there is nothing to print. Print a new password instead.`,
        409,
        { resettable: true }
      );
    }
    password = link.password_current;
  }

  const lines = buildLoginTicket({
    restaurantName: restaurant.name,
    username,
    password,
    appUrl: publicBase(),
    actor,
    includeSetupSteps,
    rotated: mode === "reset",
  });

  // Queued, not printed. Same contract as test_print and every real order:
  // the printer claims it on its ordinary poll, so a printer that is
  // unplugged holds the job rather than losing it. An offline printer is
  // therefore NOT refused here - `device_online` says so and the CRM reports
  // it, because the usual reason to print a login is that somebody is
  // standing at the printer about to plug it in.
  const { data: job, error: jobError } = await admin
    .from("print_jobs")
    .insert({ device_id: device.id, kind: "document", document: lines, queued_by: "login_print" })
    .select("id")
    .single();
  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });

  await audit({
    restaurantId: restaurant.id,
    username,
    action: "password_printed",
    actor,
    note: `printed on ${device.name} (job ${job.id})`,
  });

  return NextResponse.json({
    ok: true,
    job_id: job.id,
    device: { id: device.id, name: device.name },
    username,
    mode,
    printed_at: new Date().toISOString(),
    // Not a failure, and not hidden either: a printer that has not checked in
    // recently will print this whenever it next does.
    device_last_seen_at: device.last_seen_at ?? null,
    ...(chosen.alternatives > 0 ? { other_active_printers: chosen.alternatives } : {}),
    note: "Queued. The printer prints it on its next poll - typically within a few seconds.",
  });
}
