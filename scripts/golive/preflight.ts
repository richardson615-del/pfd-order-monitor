/**
 * GL1 preflight: the three refusals every GL script runs before it writes.
 *
 *   1. The base URL is not production (http.ts baseUrl()).
 *   2. The database looks like a dev database: no real orders in 7 days,
 *      a dev-sized roster (db.ts guardDatabase()).
 *   3. The deployment serves THAT database: its unfiltered roster lists
 *      exactly the restaurants the database holds (lib.ts checkSameDatabase).
 *
 * Read-only. Any refusal throws "REFUSED: ..." and nothing has been written.
 */
import { baseUrl, crm } from "./http";
import { allRestaurantIds, guardDatabase, type Db } from "./db";
import { checkSameDatabase, type DbActivity } from "./lib";

export async function preflight(db: Db): Promise<{ baseUrl: string; activity: DbActivity; restaurants: number }> {
  const url = baseUrl();
  const activity = await guardDatabase(db);
  const roster = await crm("/api/crm/restaurants");
  if (roster.status === 401 || roster.status === 503) {
    throw new Error(`REFUSED: ${url} answered ${roster.status} to the CRM key - GL_CRM_WRITE_KEY must be that deployment's CRM_WRITE_KEY`);
  }
  if (!roster.ok || !Array.isArray(roster.body?.restaurants)) {
    throw new Error(`REFUSED: GET /api/crm/restaurants on ${url} answered ${roster.status}: ${roster.text.slice(0, 200)}`);
  }
  const rosterIds = (roster.body.restaurants as { id: string }[]).map((r) => r.id);
  const mismatch = checkSameDatabase(rosterIds, await allRestaurantIds(db));
  if (mismatch) throw new Error(`REFUSED: ${mismatch}`);
  return { baseUrl: url, activity, restaurants: rosterIds.length };
}
