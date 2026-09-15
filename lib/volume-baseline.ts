import type { HealthIssue } from "@/lib/health";

/**
 * Revenue that should exist and doesn't (the third tripwire, after
 * webhook_partial_rejected and cron liveness).
 *
 * Those two catch work that arrives and is refused, and workers that stop
 * running. Neither can see the quietest failure of all: a restaurant that
 * simply stops ordering. Nothing is rejected, nothing errors, no job dies -
 * the orders just are not there, and every existing check reads that as a
 * calm week. A listing gets unpublished, a menu goes off, a kitchen turns
 * online ordering off after a bad night, an account churns without telling
 * anyone. The money stops and the system reports perfect health.
 *
 * The signal is ABSENCE measured against the restaurant's own history, not
 * against any fixed number - restaurants differ by an order of magnitude in
 * volume, so a threshold that suits one is noise or blindness for another.
 */

export interface RestaurantVolume {
  restaurant_id: string;
  name: string;
  /** Orders in the recent window. */
  recent: number;
  /** Orders in the baseline window immediately preceding it. */
  baseline: number;
  /**
   * Whether the restaurant was already ordering at the START of the baseline
   * window. A restaurant that onboarded mid-baseline has an artificially low
   * baseline rate, which would read as growth now and as collapse later.
   */
  established: boolean;
}

export interface VolumeThresholds {
  /** The window being judged. */
  recentDays: number;
  /** The window it is judged against, immediately before it. */
  baselineDays: number;
  /**
   * Below this many expected orders, no drop is distinguishable from luck.
   * A restaurant doing three orders a week cannot be judged at all.
   */
  minExpected: number;
  /**
   * How unlikely the observed count must be, under the restaurant's own
   * prior rate, before it is worth saying out loud.
   */
  maxProbability: number;
}

export const DEFAULT_VOLUME_THRESHOLDS: VolumeThresholds = {
  // Both windows are whole weeks, which is what makes this safe for
  // restaurants that close on Mondays: day-of-week composition is identical
  // on both sides, so a weekly closure cancels instead of registering as a
  // drop.
  recentDays: 7,
  baselineDays: 28,
  // Eight expected orders. Below that even a total stop is only ~1-in-3000
  // unlikely at p=0.01, and the alert would be dominated by small
  // restaurants having ordinary quiet weeks.
  minExpected: 8,
  // 1%. Deliberately strict: this fires across every restaurant at once, so
  // a loose threshold would produce a weekly wall of noise, and a wall of
  // noise is how a channel gets muted.
  maxProbability: 0.01,
};

/**
 * P(X <= k) for a Poisson with mean lambda.
 *
 * Poisson rather than a percentage drop because the right sensitivity
 * depends on volume: a 40% fall is decisive for a restaurant doing 100 a
 * week and meaningless for one doing 5. A fixed ratio cannot express that;
 * this does, with one threshold that holds across the whole range.
 *
 * Terms are carried forward rather than computed from factorials, which
 * would overflow long before the counts here get interesting.
 */
export function poissonAtMost(k: number, lambda: number): number {
  if (lambda <= 0) return 1;
  if (k < 0) return 0;
  // exp(-lambda) underflows to 0 around lambda > 745. No restaurant is
  // ordering 745 times a week, and if one is, returning 1 (= "not unusual")
  // fails quiet rather than crying wolf.
  const first = Math.exp(-lambda);
  if (first === 0) return 1;
  let term = first;
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

const pct = (n: number) => `${Math.round(n)}%`;

/**
 * Restaurants whose recent volume is too far below their own baseline to be
 * chance.
 *
 * Severity is WARNING, never critical, and that is a deliberate call rather
 * than an oversight: criticals are wired to SMS in this codebase, and a
 * restaurant having a bad week is not worth waking someone at 3am. It is
 * worth a Slack line and a look the next morning, which is exactly what a
 * warning does here.
 */
export function volumeIssues(
  rows: RestaurantVolume[],
  t: VolumeThresholds = DEFAULT_VOLUME_THRESHOLDS
): HealthIssue[] {
  const out: HealthIssue[] = [];
  for (const r of rows) {
    if (!r.established) continue;
    const expected = (r.baseline / t.baselineDays) * t.recentDays;
    if (expected < t.minExpected) continue;
    if (r.recent >= expected) continue;
    if (poissonAtMost(r.recent, expected) >= t.maxProbability) continue;

    const drop = (1 - r.recent / expected) * 100;
    const weekly = (r.baseline / t.baselineDays) * 7;
    out.push({
      key: `volume_collapse:${r.restaurant_id}`,
      severity: "warning",
      title:
        r.recent === 0
          ? `No orders at all from ${r.name} in ${t.recentDays} days`
          : `${r.name} is down ${pct(drop)} against its own baseline`,
      detail:
        `${r.recent} order(s) in the last ${t.recentDays} days, against ${expected.toFixed(1)} expected ` +
        `from its previous ${t.baselineDays} days (about ${weekly.toFixed(0)} a week). ` +
        `Nothing has been rejected and no job has failed - the orders are simply not arriving. ` +
        `Usual causes: the Zuppler listing was unpublished, the menu was taken offline, the kitchen ` +
        `turned online ordering off, or the account has churned. If other restaurants are down at the ` +
        `same time, check webhook_partial_rejected first - refused orders look identical to absent ones from here.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* database side                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per-restaurant order counts for both windows.
 *
 * PostgREST caps a response at 1000 rows, so this pages. The cap below bounds
 * the work a single health run can do: past it the check degrades (some
 * restaurants go unjudged) rather than slowing the run that every other check
 * shares. If order volume ever makes that routine, the upgrade is a Postgres
 * aggregate rather than a bigger page budget.
 */
const PAGE = 1000;
const MAX_PAGES = 12;

export async function collectRestaurantVolumes(
  admin: { from: (t: string) => any },
  names: Map<string, string>,
  now: Date = new Date(),
  t: VolumeThresholds = DEFAULT_VOLUME_THRESHOLDS
): Promise<RestaurantVolume[]> {
  const day = 24 * 60 * 60 * 1000;
  const recentStart = new Date(now.getTime() - t.recentDays * day);
  const baselineStart = new Date(now.getTime() - (t.recentDays + t.baselineDays) * day);
  // The oldest week of the baseline. An order in here is what proves the
  // restaurant was already running before the baseline began.
  const establishedBefore = new Date(baselineStart.getTime() + 7 * day);

  const rows: { restaurant_id: string; received_at: string }[] = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await admin
        .from("orders")
        .select("restaurant_id, received_at")
        .gte("received_at", baselineStart.toISOString())
        .neq("source", "test")
        .order("received_at", { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) {
        console.error("volume baseline: order fetch failed:", error.message);
        return [];
      }
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  } catch (err) {
    console.error("volume baseline: order fetch failed:", err);
    return [];
  }

  const acc = new Map<string, { recent: number; baseline: number; established: boolean }>();
  for (const o of rows) {
    if (!o.restaurant_id) continue;
    const at = new Date(o.received_at);
    const e = acc.get(o.restaurant_id) ?? { recent: 0, baseline: 0, established: false };
    if (at >= recentStart) e.recent++;
    else e.baseline++;
    if (at < establishedBefore) e.established = true;
    acc.set(o.restaurant_id, e);
  }

  return [...acc.entries()].map(([restaurant_id, e]) => ({
    restaurant_id,
    name: names.get(restaurant_id) ?? "unknown restaurant",
    ...e,
  }));
}
