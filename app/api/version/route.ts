import { NextResponse } from "next/server";
import { minShellVersion } from "@/lib/app-update";

export const dynamic = "force-dynamic";

/**
 * GET /api/version -> { buildId, minShellVersion }
 *
 * What deployment is serving right now. Unauthenticated and deliberately
 * uninformative: a git sha, and nothing else. An uptime pinger can read it,
 * and so can a tablet that has been open for three weeks.
 *
 * The client has its own build id inlined at compile time (see
 * next.config.js). When the two differ, the page is running code older than
 * the server is serving - which is the normal state of a kiosk, because
 * nothing ever reloads it.
 *
 * no-store on purpose. A cached answer here would be a version check that
 * reports the version it was told about last week.
 *
 * minShellVersion is the oldest Android shell (appVersionCode) the office is
 * happy to see on a wall. From MIN_SHELL_VERSION in the environment, default
 * 0 meaning "no opinion". A tablet below it shows one amber line and asks
 * the restaurant for nothing - the MDM pushes shells, restaurants never
 * download anything.
 */
export async function GET() {
  return NextResponse.json(
    { buildId: process.env.VERCEL_GIT_COMMIT_SHA || "dev", minShellVersion: minShellVersion() },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
  );
}
