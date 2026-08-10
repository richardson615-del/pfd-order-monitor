import { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase-server";

export interface PrintDevice {
  id: string;
  restaurant_id: string;
  name: string;
  is_active: boolean;
}

/**
 * Authenticates a print device from the X-Device-Key header.
 * Also stamps last_seen_at + reported app/printer info on every call,
 * so the admin panel shows device health for free.
 */
export async function authenticateDevice(
  req: NextRequest
): Promise<PrintDevice | null> {
  const key = req.headers.get("x-device-key");
  if (!key) return null;

  const admin = supabaseAdmin();
  const { data: device } = await admin
    .from("print_devices")
    .select("id, restaurant_id, name, is_active")
    .eq("device_key", key)
    .eq("is_active", true)
    .maybeSingle();

  if (!device) return null;

  const updates: Record<string, unknown> = {
    last_seen_at: new Date().toISOString(),
  };
  const appVersion = req.headers.get("x-app-version");
  const printerName = req.headers.get("x-printer-name");
  if (appVersion) updates.app_version = appVersion;
  if (printerName) updates.printer_name = printerName;
  await admin.from("print_devices").update(updates).eq("id", device.id);

  return device;
}
