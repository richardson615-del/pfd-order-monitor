/**
 * The I/O half of PFD Partner sign-in and push (PA1). Rules live in
 * lib/partner-app.ts; the routes under app/api/app call these.
 *
 * Sessions are ordinary Supabase sessions for the restaurant's own login:
 *  - password: signInWithPassword on the anon client;
 *  - code: the tablet's magic-link mint (ensureTabletLogin + generateLink),
 *    redeemed here with verifyOtp so the app receives the tokens directly.
 * Nothing is emailed, and no password is ever read or reset.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase-server";
import { ensureTabletLogin } from "./provision";
import { tokenHashFrom } from "./link-code";
import { normaliseUsername, usernameToEmail, isValidUsername } from "./usernames";
import {
  CODE_FAILURE_WORDS,
  LOGIN_CODE_RATE_MAX,
  LOGIN_CODE_RATE_WINDOW_MS,
  LOGIN_CODE_TTL_MS,
  codeRowState,
  codesMatch,
  hashLoginCode,
  loginCodeText,
  newLoginCode,
  phoneTail,
} from "./partner-app";

export interface AppSession {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  restaurant: { id: string; name: string };
  owner_name: string | null;
}

type Fail = { error: string; status: number; choose?: Array<{ id: string; name: string }> };

function anonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input: any, init?: any) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

/** The code-hash secret: the service-role key, which only the server holds. */
function codeSecret(): string {
  const s = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return s;
}

/** One SMS to one number, via Twilio's REST API. Never throws; logs the reason, never the credentials or the code. */
async function textOne(to: string, body: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.error("partner app: cannot text a code, TWILIO_* not set");
    return false;
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error("partner app: code SMS failed", res.status, phoneTail(to));
    return res.ok;
  } catch (err) {
    console.error("partner app: code SMS error", err instanceof Error ? err.message : err, phoneTail(to));
    return false;
  }
}

/** The restaurants a phone may sign in to. */
async function ownerRows(phone: string) {
  const { data } = await supabaseAdmin()
    .from("app_owner_phones")
    .select("restaurant_id, name, restaurants!inner(id, name, is_active)")
    .eq("phone", phone);
  return ((data ?? []) as any[])
    .filter((r) => r.restaurants?.is_active !== false)
    .map((r) => ({ restaurantId: r.restaurant_id as string, restaurantName: r.restaurants.name as string, name: (r.name as string | null) ?? null }));
}

/**
 * Text a code to a phone on file. The answer is the same whether or not the
 * phone is on file, so the endpoint can't be used to find owners' numbers.
 */
export async function requestLoginCode(phone: string): Promise<{ ok: true } | Fail> {
  const admin = supabaseAdmin();
  const now = Date.now();
  const { data: recent } = await admin
    .from("app_login_codes")
    .select("id")
    .eq("phone", phone)
    .gte("created_at", new Date(now - LOGIN_CODE_RATE_WINDOW_MS).toISOString());
  if ((recent ?? []).length >= LOGIN_CODE_RATE_MAX) return { error: "Too many codes for this number. Wait a few minutes and try again.", status: 429 };

  const owners = await ownerRows(phone);
  if (!owners.length) return { ok: true };

  const code = newLoginCode((n) => randomBytes(n));
  const { error } = await admin.from("app_login_codes").insert({
    phone,
    code_hash: hashLoginCode(phone, code, codeSecret()),
    expires_at: new Date(now + LOGIN_CODE_TTL_MS).toISOString(),
  });
  if (error) return { error: "Couldn't make a code right now. Try again.", status: 500 };
  const sent = await textOne(phone, loginCodeText(code));
  if (!sent) return { error: "Couldn't send the text. Try again, or sign in with your username and password.", status: 502 };
  return { ok: true };
}

/** Mint a session for a restaurant's login: the tablet's magic-link path, redeemed here. */
async function sessionForRestaurant(restaurant: { id: string; name: string }, ownerName: string | null): Promise<AppSession | Fail> {
  const login = await ensureTabletLogin(restaurant, "pfd-partner-app");
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: "magiclink", email: login.email });
  const token_hash = tokenHashFrom(data);
  if (error || !token_hash) return { error: "Couldn't sign you in right now. Try again.", status: 500 };
  const { data: verified, error: vErr } = await anonClient().auth.verifyOtp({ type: "magiclink", token_hash });
  const s = verified?.session;
  if (vErr || !s) return { error: "Couldn't sign you in right now. Try again.", status: 500 };
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? null, restaurant, owner_name: ownerName };
}

/** Redeem a texted code. A phone on file for several restaurants must say which (restaurantId). */
export async function verifyLoginCode(phone: string, code: string, restaurantId: string | null): Promise<AppSession | Fail> {
  const admin = supabaseAdmin();
  const now = Date.now();
  const { data: row } = await admin
    .from("app_login_codes")
    .select("id, code_hash, expires_at, attempts, used_at")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return { error: CODE_FAILURE_WORDS.wrong, status: 401 };
  const state = codeRowState(row, now);
  if (state) return { error: CODE_FAILURE_WORDS[state], status: 401 };
  if (!codesMatch(row.code_hash, phone, code, codeSecret())) {
    await admin.from("app_login_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return { error: CODE_FAILURE_WORDS.wrong, status: 401 };
  }

  const owners = await ownerRows(phone);
  if (!owners.length) return { error: CODE_FAILURE_WORDS.wrong, status: 401 };
  const pick = restaurantId ? owners.find((o) => o.restaurantId === restaurantId) : owners.length === 1 ? owners[0] : null;
  if (!pick) {
    // The code stays good so the owner can choose without a second text.
    return { error: "Pick the restaurant to sign in to.", status: 409, choose: owners.map((o) => ({ id: o.restaurantId, name: o.restaurantName })) };
  }
  await admin.from("app_login_codes").update({ used_at: new Date(now).toISOString() }).eq("id", row.id);
  return sessionForRestaurant({ id: pick.restaurantId, name: pick.restaurantName }, pick.name);
}

/** The fallback: the restaurant's username and password (the same login as the tablet). */
export async function passwordLogin(usernameRaw: string, password: string): Promise<AppSession | Fail> {
  const username = normaliseUsername(usernameRaw);
  if (!isValidUsername(username) || !password) return { error: "Wrong username or password.", status: 401 };
  const { data, error } = await anonClient().auth.signInWithPassword({ email: usernameToEmail(username), password });
  const s = data?.session;
  if (error || !s) return { error: "Wrong username or password.", status: 401 };
  const { data: links } = await supabaseAdmin()
    .from("restaurant_users")
    .select("restaurant_id, restaurants!inner(id, name)")
    .eq("auth_user_id", s.user.id)
    .limit(1);
  const r = (links as any[] | null)?.[0]?.restaurants;
  if (!r) return { error: "That login isn't linked to a restaurant. Call dispatch.", status: 403 };
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? null, restaurant: { id: r.id, name: r.name }, owner_name: null };
}

/** A fresh access token from a refresh token. */
export async function refreshAppSession(refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_at: number | null } | Fail> {
  const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
  const s = data?.session;
  if (error || !s) return { error: "Please sign in again.", status: 401 };
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? null };
}

export async function registerPushToken(input: { token: string; restaurantId: string; platform: "ios" | "android" | null; ownerName: string | null }): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("app_push_tokens")
    .upsert(
      { token: input.token, restaurant_id: input.restaurantId, platform: input.platform, owner_name: input.ownerName, last_seen_at: new Date().toISOString() },
      { onConflict: "token" }
    );
  return !error;
}

export async function removePushToken(token: string): Promise<void> {
  await supabaseAdmin().from("app_push_tokens").delete().eq("token", token);
}

/**
 * Push to every phone signed in to the restaurant's app (Expo push service).
 * Never throws: a push failing must never fail the reply that caused it.
 * Phones Expo reports as gone are forgotten.
 */
export async function pushToRestaurantApps(restaurantId: string, msg: { title: string; body: string; data?: Record<string, unknown> }): Promise<{ sent: number }> {
  try {
    const { data: rows } = await supabaseAdmin().from("app_push_tokens").select("token").eq("restaurant_id", restaurantId);
    const tokens = (rows ?? []).map((r) => r.token as string);
    if (!tokens.length) return { sent: 0 };
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(tokens.map((to) => ({ to, title: msg.title, body: msg.body.slice(0, 180), data: msg.data ?? {}, sound: "default" }))),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("partner app: push failed", res.status);
      return { sent: 0 };
    }
    const json = (await res.json().catch(() => null)) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null;
    let sent = 0;
    for (const [i, t] of (json?.data ?? []).entries()) {
      if (t.status === "ok") sent++;
      else if (t.details?.error === "DeviceNotRegistered" && tokens[i]) await removePushToken(tokens[i]!);
    }
    return { sent };
  } catch (err) {
    console.error("partner app: push error", err instanceof Error ? err.message : err);
    return { sent: 0 };
  }
}
