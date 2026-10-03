// Whether a build may touch the database (ported from prs-crm #535, Matt
// 2026-10-02).
//
// vercel-build runs scripts/migrate.mjs before next build on EVERY Vercel
// deployment. When MIGRATION_DATABASE_URL is set for the Preview environment
// too, an unmerged PR's migration runs against the production database from
// its preview build - exactly what happened in prs-crm (an unmerged PR's
// migration landed in production before review). So:
//
//   - On Vercel, only VERCEL_ENV === "production" migrates. Preview and
//     development log "migrations skipped (<env>)" and the build carries on.
//   - Off Vercel (VERCEL_ENV unset: a laptop, CI) nothing changes.

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ run: boolean, env: string | null }}
 */
export function buildDbStepAllowed(env) {
  const vercelEnv = env.VERCEL_ENV?.trim() || null;
  if (vercelEnv === null) return { run: true, env: null };
  return { run: vercelEnv === "production", env: vercelEnv };
}

/**
 * Exits 0 with "<step> skipped (<env>)" when the step must not run here, so
 * `migrate && next build` carries on.
 *
 * @param {string} step
 * @param {Record<string, string | undefined>} env
 */
export function exitUnlessBuildDbStepAllowed(step, env = process.env) {
  const gate = buildDbStepAllowed(env);
  if (!gate.run) {
    console.log(`${step} skipped (${gate.env})`);
    process.exit(0);
  }
}
