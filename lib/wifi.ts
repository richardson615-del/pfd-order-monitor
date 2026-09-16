/**
 * Handing the restaurant to Android's own Wi-Fi picker.
 *
 * A web page cannot join a network. The in-app network list in the design
 * is a picture of the ANDROID picker, not a thing to build - so the one
 * button on the Wi-Fi screen is a link that asks Android to open it.
 *
 * Chrome turns an `intent:` URL into an Android intent when it is opened
 * from a user gesture. Two are offered, in order of preference:
 *
 *   1. The Wi-Fi settings PANEL (Android 10+): a sheet over the app that
 *      lists networks and takes a password, then returns. The app never
 *      leaves the screen, which is what a kiosk wants.
 *   2. The full Wi-Fi SETTINGS screen, for a tablet whose Android is too
 *      old for the panel.
 *
 * Chrome falls back to `S.browser_fallback_url` when no activity can take
 * the intent - which is what happens under a kiosk policy that has not
 * whitelisted Settings. The fallback is our own page saying so, rather than
 * a button that does nothing.
 *
 * UNKNOWN until probed on the trial tablet under the Hexnode kiosk policy
 * (docs/kiosk.md, "The Wi-Fi hand-off"): whether lock-task mode lets the
 * panel open at all. The escape hatch is the MDM pushing the store's Wi-Fi
 * profile, collected on the go-live call. Nothing here depends on the
 * answer; only which button the restaurant ends up pressing does.
 */

const WIFI_PANEL_ACTION = "android.settings.panel.action.WIFI";
const WIFI_SETTINGS_ACTION = "android.settings.WIFI_SETTINGS";

/** Where Chrome sends the tablet when Android refuses the intent. */
export const WIFI_FALLBACK_PATH = "/offline.html?wifi=unavailable";

export function wifiIntentUrl(action: string, fallbackUrl: string | null): string {
  const fallback = fallbackUrl ? `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};` : "";
  return `intent:#Intent;action=${action};${fallback}end`;
}

/** The button's href. `origin` is the page's own, for the fallback URL. */
export const wifiPanelUrl = (origin: string | null): string =>
  wifiIntentUrl(WIFI_PANEL_ACTION, origin ? `${origin}${WIFI_FALLBACK_PATH}` : null);

export const wifiSettingsUrl = (origin: string | null): string =>
  wifiIntentUrl(WIFI_SETTINGS_ACTION, origin ? `${origin}${WIFI_FALLBACK_PATH}` : null);

export const WIFI_BUTTON_LABEL = "Choose Wi-Fi network";
