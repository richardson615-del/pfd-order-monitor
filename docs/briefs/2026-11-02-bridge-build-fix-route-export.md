# BF1 — Bridge production build fix: invalid route export (Nick, 2026-11-02)

Production builds on Vercel have failed since #132 (Eatabit printers, the preview-build change and #135 all failed). Fix it.

Error from the Vercel build log (commit 947d9aa):
  app/api/print/epson/route.ts
  Type error: "isTextOnlyPrinter" is not a valid Route export field.

1. Save this as docs/briefs/2026-11-02-bridge-build-fix-route-export.md and add a QUEUE.md row (BF1, ahead of the GL1 rows).
2. Move isTextOnlyPrinter out of app/api/print/epson/route.ts into a lib file (e.g. lib/printers/text-only.ts). Update every import, tests included. Route files may only export HTTP handlers and Next route config fields.
3. Check every other app/**/route.ts, page.tsx and layout.tsx for exports Next doesn't allow, and fix them the same way.
4. Add a `next build` step to CI so this can't pass CI again. Use dummy env values. It must NOT run scripts/migrate.mjs against any real database. Never print .env values.
5. Check that `npx next build` passes locally. Open a PR with squash auto-merge on green CI.
6. After it merges, check the Vercel Deployments page and confirm the main production deploy shows Ready/Current. Do not run vercel --prod.

Report back: the PR number, whether CI passed, and whether the production deploy is live.

---
Note (Claude Code, 2026-11-02): GitHub's Vercel status shows #132 (75d6c5f) deployed successfully; the failures are #131 (c19b630), #133 (e1db6ae) and #135 (947d9aa). #131 introduced the export, so #132's success is unexplained (Data missing) — the fix is the same either way.
