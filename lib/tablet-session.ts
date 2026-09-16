import { supabaseAdmin } from "./supabase-server";
import { ensureTabletLogin, type EnsuredLogin } from "./provision";
import { tokenHashFrom } from "./link-code";

/**
 * A session for a restaurant's tablet, minted server-side.
 *
 * Two ways a tablet gets its session with nobody typing - the office
 * linking a code (app/api/crm/tablets/link) and the tablet bootstrapping
 * its device reference (app/api/kiosk/bootstrap) - and one way the session
 * is actually made: the restaurant's tablet login (found or created by the
 * rule provisioning uses; never a second login, never a reset password)
 * gets a Supabase magic link generated here. Nothing is emailed. The hash
 * goes to exactly one device, which verifies it in the browser; that is
 * what sets the cookies. Nobody sees it.
 */
export interface MintedSession {
  token_hash: string;
  login: EnsuredLogin;
}

export async function mintTabletSession(
  restaurant: { id: string; name: string },
  actor: string | null
): Promise<MintedSession | { error: string }> {
  const login = await ensureTabletLogin(restaurant, actor);
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: "magiclink", email: login.email });
  const token_hash = tokenHashFrom(data);
  if (error || !token_hash) return { error: error?.message ?? "auth did not return a usable link" };
  return { token_hash, login };
}
