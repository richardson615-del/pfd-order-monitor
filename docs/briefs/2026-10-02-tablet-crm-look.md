# Claude Code instruction package — Workstream Z: tablet app gets the CRM look

> **Status (2026-10-02):** Z1 shipped as PR #99 (merged). Z2 + Z3 shipped together as the follow-up PR — see QUEUE row 12.

Repo: `pfd-order-monitor` (C:\Users\richa\dev\pfd-order-monitor). Single repo — no CRM change.
Requested by Nick, 2026-10-02: "make the app's design more similar to the CRM — visually more clean."
Repo rules (README.md, docs/crm-bridge-contract.md, QUEUE.md header) win over this brief. On conflict, stop and say so.

**This is a visual change only.** No behaviour, data, API, sound, print, polling, alert-gate or kiosk-flow change. If a step seems to need one, stop and say so.

---

## Ground truth

### FACT — the CRM look (prs-crm, read 2026-10-02)
| Element | Where | Value |
|---|---|---|
| Theme | `src/app/globals.css:77-168` | Light-first. `--background oklch(0.99 0.002 264)`, `--card oklch(1 0 0)`, `--foreground oklch(0.18 0.014 264)`, `--muted-foreground oklch(0.5 0.014 264)`, `--border oklch(0.9 0.006 264)`, `--surface-sunken oklch(0.976 0.004 264)` (page ground under white cards) |
| Accent | same | Single indigo `--primary oklch(0.511 0.262 276.966)`; `--accent oklch(0.94 0.03 277)` / `--accent-foreground oklch(0.32 0.16 277)` |
| Status | same, 116-123 | `--status-online oklch(0.58 0.14 152)`, `--status-warning oklch(0.72 0.16 70)` (fg `oklch(0.26 0.07 70)`), `--status-critical oklch(0.577 0.245 27.325)` |
| Dark set | `globals.css:170-227` | Exists (`.dark`), indigo `oklch(0.65 0.2 277)` |
| Radius | `--radius: 0.75rem`; cards `rounded-xl` (≈1.05rem); buttons `rounded-lg` | |
| Type | `src/app/layout.tsx` | Body **Geist** (`--font-sans`), headings **Sora** (`--font-heading`), both via `next/font/google`; `antialiased` |
| Headings | `components/shell/PageHeader.tsx:29-32` | Eyebrow 11px semibold uppercase tracking 0.08em muted; title Sora semibold, tight tracking — **mixed case, not ALL CAPS, weight 600 not 800-900** |
| Motion | `globals.css:235-237` | `--duration-fast 150ms`, `--duration-base 220ms`, `--ease-out cubic-bezier(0.16,1,0.3,1)`; reduced-motion honoured |
| Numbers | `.money { font-variant-numeric: tabular-nums }` | |

### FACT — the tablet app today (pfd-order-monitor)
- Next 14.2.15, React 18, **no Tailwind, no shadcn** (`package.json`). All styling is plain CSS in `app/globals.css` (1,356 lines, ~230 rules) driven by tokens in `:root` (`globals.css:17-60`): `--bg #0b0d10`, `--panel #14181d`, `--panel-2`, `--border`, `--text`, `--text-dim`, `--brand #38bdf8` (sky), `--age-calm/warn/late`, `--st-waiting/done/printed`, legacy aliases `--new/--opened/--completed/--printed`, `--radius-sm/md/lg` (10/14/20px), `--text-xs..lg`.
- One palette by design (header comment `globals.css:1-15`, 2026-09-14): dark, "status colours are the only saturated things." Red = late, amber = warning, green = done/Accept.
- Font: Plus Jakarta Sans 600/700/800 as `--font-brand` for wordmark, headings, counts, order numbers; body on the system stack (`app/layout.tsx`).
- Heavy weights and caps throughout: `font-weight: 800/900` at `globals.css:598, 674, 717, 740, 776, 873, 884, 900, 912, 940, 973, 1020, 1024, 1051, 1085, 1086, 1109, 1125, 1134, 1168, 1180`; `text-transform: uppercase` at `227, 239, 451, 539, 877, 913, 975, 1023, 1050, 1071, 1098, 1109, 1138, 1265`.
- `viewport.themeColor "#0b0d10"` (`app/layout.tsx:42`).
- `components/Brand.tsx` already supports `onLight` (gradient `#0284c7 → #0ea5e9`, sub-text `#475569`).
- Ticket print preview uses `.receipt`, `.receipt-paper`, `.tl*` (`globals.css:296-365`) — it imitates thermal paper and must stay black-on-white monospace.
- Screens in scope: dashboard (`OrderDashboard`, `OrderCard`, `CompletedRow`, `PastWeek`), ticket (`OrderViewer`, `TicketBody`), `ReadyScreen`, `AlertGate`, pairing/link (`app/link/page.tsx`), login (`app/login/page.tsx`), offline strip, admin (`AdminPanel`, `EzCaterAdmin`).
- Prior screenshots live in `docs/screenshots/2026-09-1x-*` (800×1280 portrait).

### ASSUMPTION — Nick's intent
- "Similar to the CRM" = same palette (light, white cards on a soft grey ground, one indigo accent), same fonts (Geist + Sora), same radius/borders/shadows, mixed-case semibold headings, calmer weights. Not a port of the CRM's code.
- The tablet stays readable across a kitchen: large sizes stay large; only weight, case, colour and chrome get calmer.
- Status meaning is unchanged: red = late/not accepted, amber = getting late, green = Accept/done. Those are re-pointed at the CRM's status tokens so both apps use the same red, amber and green.

### UNKNOWN — probe first
- Whether `scripts/build-demo.ts` / `preview-out/` is what produced the existing screenshots. Find the screenshot path used for `docs/screenshots/2026-09-17-accept-countdown/`; if none exists, add a small Playwright script (dev dependency only) that renders the demo states at 800×1280.
- Whether any inline `style={{ color: "#..." }}` / hard-coded hex values exist in components outside `globals.css`. Grep `#[0-9a-fA-F]{3,6}` and `rgba(` in `components/` and `app/`; re-point each to a token.
- Whether `next/font/google` `Geist` is available on Next 14.2.15. If not, use the `geist` npm package (`geist/font/sans`) for body and keep `next/font/google` for Sora.

---

## Z1 — Tokens and fonts (one PR)

**Build**
1. `app/globals.css` `:root`: replace the values with the CRM's light tokens, keeping every existing token **name** so no call site changes:
   - `--bg` → CRM `--surface-sunken`; `--panel` → CRM `--card`; `--panel-2` → CRM `--muted`; `--border` → CRM `--border`; `--text` → CRM `--foreground`; `--text-dim` → CRM `--muted-foreground`.
   - `--brand`/`--accent` → CRM `--primary`; `--brand-2` → `oklch(0.62 0.2 277)`.
   - `--age-late`/`--st-waiting` → CRM `--status-critical`; `--age-warn` → CRM `--status-warning`; `--st-done` → CRM `--status-online`; `--age-calm`/`--st-printed` → CRM `--muted-foreground`.
   - Add the CRM names alongside (`--background`, `--card`, `--foreground`, `--muted`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--accent`, `--accent-foreground`, `--status-*` incl. `-foreground`, `--surface-sunken`, `--radius: 0.75rem`, `--duration-fast`, `--duration-base`, `--ease-out`) with a header comment: *"Copied from prs-crm src/app/globals.css on 2026-10-02 — keep in step with the CRM."*
   - `--radius-sm/md/lg` → `calc(var(--radius)*0.8)` / `var(--radius)` / `calc(var(--radius)*1.4)`.
   - Replace the "ONE PALETTE" header comment with the reason for the change (Nick 2026-10-02: match the CRM; light, clean). Keep the "a red thing is always a late thing" rule in the comment.
   - Copy the CRM `.dark` block as `.dark` (not applied anywhere yet — see open question 1).
   - Add the CRM's `prefers-reduced-motion` block.
2. Text on coloured fills: wherever a red/amber/green fill carries text (badges, Accept button, kiosk banners `globals.css:262-263`, `.card-flag`), use the matching `--status-*-foreground` so contrast holds on light.
3. Shadows: the dark-era `rgba(0,0,0,0.5)` shadows become CRM-like subtle depth: cards `0 1px 2px oklch(0.18 0.014 264 / 0.06), 0 0 0 1px var(--border)`. Keep `.receipt-paper`'s own shadow light (`0 1px 3px … /0.12`).
4. Fonts (`app/layout.tsx`): body **Geist** as `--font-sans` on `<html>`, headings/numbers **Sora** 600/700 as `--font-heading`. Point the old `--font-brand` at `--font-heading` so existing rules keep working; remove Plus Jakarta Sans. `body { font-family: var(--font-sans), system-ui, sans-serif; -webkit-font-smoothing: antialiased; }`.
5. `viewport.themeColor` → the new `--bg` as hex (`#f7f8fa`, or compute from the oklch). Check `appleWebApp.statusBarStyle` → `"default"`.
6. `components/Brand.tsx`: callers on the new light ground pass `onLight`; change the `onLight` gradient to the indigo pair (`--primary` → `--brand-2`) and sub-text to `--muted-foreground`. **Do not touch** `public/icons/*` (launcher/notification icons ship with the APK/TWA — out of scope).
7. Leave `.receipt`, `.receipt-paper`, `.tl*` visually identical (still black on white).

**Tests**: `npm test` green; `npm run build` green; grep shows no remaining hex colours in components except inside `.receipt*`/`.tl*` and `Brand.tsx`'s gradient stops.

**Acceptance**: every screen renders on the light palette with no dark panels left over; status colours keep their meaning.

---

## Z2 — Clean-up pass on the screens (one PR, after Z1 merges)

Rule of thumb: same size, calmer. Keep every font **size** that is read across a room (order number, timer, total, waiting count, Accept); change weight, case, colour and chrome.

**Build**
1. Weights: 900 → 700, 800 → 600 across `globals.css` (lines listed in FACT). Order number, timer and waiting count use `--font-heading` 700 with `letter-spacing: -0.02em` and `tabular-nums`.
2. Case: customer names (`.card-name`, `.ticket-name` `globals.css:1109`) and the Accept button (`.ticket-accept` 1098) go to normal case. ALL CAPS stays only for small eyebrow labels (`PICKUP`/`DELIVERY`, `.tk-label`, `.week-day`, `.done-kind`, `LIVE`) at 11-12px, semibold, tracking 0.08em, `--text-dim` — the CRM `PageHeader` eyebrow style.
3. Order cards (`.app .card`, `globals.css:836-865`): white `--card`, 1px `--border`, radius `--radius-lg`, the shadow from Z1, 16-20px padding. Keep the 4px left status bar (`::before`) — that's the at-a-glance cue — but in the CRM status tokens. "Not accepted" card: Accept button full-width inside the card, `--status-online` fill, `--status-online-foreground` text, 600 weight, radius `--radius-md`, min-height 64px.
4. Status pills (`.badge`, `.card-flag`): CRM Badge style — pill radius, 12px semibold, tinted fill `color-mix(in oklch, var(--status-x) 14%, transparent)` with the status colour as text; the overdue pill (`+5:16 over`) stays a solid `--status-critical` fill so it shouts.
5. Header (`.app-head`): white bar, bottom border, restaurant name in Sora 600 mixed case, `Premium` wordmark small via `Brand onLight`, `LIVE` as a green dot + eyebrow text, clock in `--text-dim` tabular.
6. Tabs (`.tabs`, `.tab`): CRM segmented look — `--muted` track, active tab white card with subtle shadow, count in `--text-dim`.
7. Summary line (`.app-hero`): Sora 600, red only for the late part (e.g. "4 orders · **1 not accepted · +5:16 over**" with only the bold part in `--status-critical`).
8. Ticket screen (`OrderViewer`/`TicketBody`): white sheet on `--bg`, line items as rows divided by `--border`, prices right-aligned `tabular-nums` in `--text-dim`, modifiers (`– Dressed`) in `--status-warning-foreground`-on-light colour (amber that passes 4.5:1, e.g. `oklch(0.55 0.15 60)`), phone number in `--primary`. Bottom action bar: white with top border; "Print again" = CRM outline button; Accept = primary green as in step 3.
9. Ready, pairing/link, alert gate, login, offline strip: centred white card (`--radius-xl`) on `--bg`, Sora 600 title, body in `--text-dim`, primary button indigo. Pairing code digits keep their size, weight 700, tabular.
10. Admin screens (`AdminPanel`, `EzCaterAdmin`): inherit tokens; only fix anything Z1 left unreadable.
11. Motion: transitions use `--duration-fast`/`--ease-out`; no new animations.

**Tests**: `npm test` green; contrast check — add `scripts/test-theme-contrast.ts` (wire into `npm test`) that parses the `:root` tokens and asserts: `--text`, `--text-dim` ≥ 4.5:1 on `--panel` and `--bg`; each `--status-*-foreground` ≥ 4.5:1 on its `--status-*`; red/amber/green status colours ≥ 3:1 on `--panel`. Use a tiny oklch→sRGB conversion in the script; no new runtime dependency.

**Acceptance**: side-by-side screenshots (Z3) look like the CRM's family; a late order is still the most obvious thing on the dashboard from arm's length.

---

## Z3 — Screenshots and hand-off (same PR as Z2)

1. Regenerate at 800×1280 into `docs/screenshots/2026-10-02-crm-look/`: orders with countdown (new, warn, late, accepted), completed, past week, ticket new (Accept), ticket counting down, ready screen, pairing code, alert gate, login, offline strip. Same demo data as `2026-09-17-accept-countdown` so before/after compare 1:1.
2. Put 4 before/after pairs in the PR body (orders, ticket, ready, login).
3. QUEUE.md: row 12 → `PR #n`.

---

## Delivery rules
Branch per package → CI green → `gh pr merge --auto --squash <n>`. Never push to main, never `vercel --prod*`, never print `.env*`. No migrations in this workstream. Z2 starts after Z1 merges. Tablets pick the change up on their next idle reload (`/api/version`) — no APK release needed.

## Open questions for Nick (Claude Code proceeds on the **bold default**)
1. Dark mode for night service? **Default: light only now; CRM `.dark` tokens are copied in but not applied. A per-tablet toggle is a later brief if a restaurant asks.**
2. Launcher / notification icon (still the old blue "PFD" square) — restyle to indigo too? **Default: no, out of scope (needs an APK/TWA build).**
3. Keep the 4px coloured left edge on order cards? **Default: yes.**
