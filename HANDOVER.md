# NEOTRACE — Handover

**Project:** NEOTRACE Fase 1 web app — PT Neopangan Selaras Indonesia (Neofood), Sauce Division
**Location:** `D:\Pointstar\OneDrive - 明 and Daughters\Team Lead\Testing AI\neotrace-web`
**Written:** 15 Aug 2026 · **Status:** app shell complete, builds clean, not yet connected to a live Supabase project

Read this top to bottom before touching code. Everything a new session needs is here.

---

## 1. What this is

A React PWA for lot traceability on the sauce production floor. Phone-first for operators
(receive, scan, consume, CCP), same pages on desktop for QA and finance (QC release, trace, cost).

Business goals of Fase 1 (from `NEOTRACE_Fase1_Rencana_Kerja.xlsx`):
actual HPP per batch · two-way lot traceability · consignment (client-owned material) reconciliation.

Go-live target in the plan: **02 Oct 2026**, 6 working weeks from 24 Aug 2026.

In scope: v1 schema + QR scan + FEFO enforcement + QC hold + expiry alerts.
Out of scope (Fase 2+): auto put-away, cross-dock, allergen rack zoning, pick lists, wave picking,
packing, RFID/barcode other than QR, ERP integration, labour KPI, forecasting, dual UoM.

---

## 2. Source material

Original inputs live in `C:\Users\Adhi Nugroho\Downloads\Neotrace`:

| File | What it is | Used how |
|---|---|---|
| `api.ts` | Supabase data layer, Indonesian operator error messages | copied verbatim → `src/lib/api.ts` (one edit, see §5) |
| `offlineQueue.ts` | IndexedDB outbox + auto-flush | copied verbatim → `src/lib/offlineQueue.ts` |
| `QrScanner.tsx` | Camera scanner, BarcodeDetector + zxing fallback | copied verbatim → `src/components/QrScanner.tsx` |
| `BatchConsumePanel.tsx` | FEFO suggestion + scan confirm + override-with-reason | copied verbatim → `src/components/BatchConsumePanel.tsx` |
| `neotrace_phase1_delta.sql` | QC hold, FEFO enforcement, alerts, RLS, seed | **not yet run anywhere** |
| `neotrace_erd.svg` | Full ERD, Fase 1 vs Fase 2 marked | reference for column names |
| `NEOTRACE_Fase1_Rencana_Kerja.xlsx` | 6-week plan, 44 tasks T01–T44, milestones | scope + sequencing |

**Missing and needed:** `neotrace_schema.sql` (v1). It is referenced everywhere but was not in the folder.
Ask the user for it. Several views (`v_trace_forward`, `v_consignment_balance`, `v_batch_cost`,
`v_qc_pending` base tables) and all core tables come from it.

---

## 3. What was built (all new code)

```
neotrace-web/
  index.html                  font vars (Archivo UI + mono for codes), manifest, icon
  package.json                deps + `npm run check`
  vite.config.ts              port 5173
  tsconfig.json
  .gitignore
  scripts/check.mjs           framework-free assert self-check
  public/
    manifest.webmanifest      PWA manifest
    icon.svg                  app icon
    sw.js                     pass-through SW, installability only
  src/
    main.tsx                  root + SW registration (prod only)
    App.tsx                   auth gate, router, top bar, bottom nav, setup screen
    ui.ts                     colour tokens C, shared styles s, pill(), lotTone()
    lib/
      api.ts                  PROVIDED + config guard
      offlineQueue.ts         PROVIDED, untouched
      queries.ts              NEW — all read queries
      labels.ts               NEW — QR label generation + thermal print window
    components/
      QrScanner.tsx           PROVIDED, untouched
      BatchConsumePanel.tsx   PROVIDED, untouched
    screens/
      Login.tsx               email/password via supabase.auth
      Home.tsx                tiles + outbox/unread banners
      Scan.tsx                free LOOKUP scan; also serves route /h/:token
      Receive.tsx             GRN form → lot QUARANTINE → print N QR labels
      Qc.tsx                  QC queue, samples, tests, release / hold / recall
      Production.tsx          batch → requirements → consume → CCP → close + HPP
      Trace.tsx               forward / backward / consignment balance
      Notifications.tsx       realtime alerts, mark read
```

Design language follows the two provided components: square corners, `borderTop` accent rules
(never left side-tabs), monospace for every lot/HU/qty code, palette in `src/ui.ts`
(`ink #0E2A20`, `neo #1B7A4B`, `amber #D0870A`, `chili #C13A22`, `lab #EEF3F0`).
All copy is Bahasa Indonesia — keep it that way, operators read these screens.

---

## 4. Screen ↔ plan task mapping

| Plan task | Screen / module | State |
|---|---|---|
| T08 PWA shell + auth | `App.tsx`, `Login.tsx` | done |
| T10 API layer | `lib/api.ts` + `lib/queries.ts` | done |
| T11 GRN incl. owner + halal | `Receive.tsx` | done, untested vs live DB |
| T12 QR label print | `lib/labels.ts` | done, **needs a real thermal printer test (T09)** |
| T13 Scanner + resolve_qr | `QrScanner.tsx`, `Scan.tsx` | done |
| T14 Offline queue | `offlineQueue.ts` wired in `BatchConsumePanel` | done |
| T17 QC hold screen | `Qc.tsx` | done |
| T18 Production + FEFO | `Production.tsx` + `BatchConsumePanel` | done |
| T19 CCP readings | `CcpRow` in `Production.tsx` | done |
| T20 FEFO enforcement | database triggers (delta SQL) | code ready, SQL not run |
| Trace console (week 4) | `Trace.tsx` | partial — see §7 |

Tasks T01–T07 (Supabase provisioning, schema runs, RLS testing, master data import,
CCP definitions) are infrastructure/data work — **none of it has been done**.

---

## 5. The only change made to provided code

`src/lib/api.ts`, top of file. Original called `createClient(import.meta.env.VITE_SUPABASE_URL, ...)`
directly, which throws at import time when `.env` is absent → white screen. Now:

```ts
const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const isConfigured = Boolean(URL && KEY);
export const supabase: SupabaseClient = createClient(
  URL || 'http://localhost:54321',
  KEY || 'anon-belum-diisi',
  { auth: { persistSession: true, autoRefreshToken: true } }
);
```

`App.tsx` reads `isConfigured` and renders a setup screen instead. Everything else in the four
provided files is byte-identical to the originals.

---

## 6. Verification already done

- `npx tsc -b` — clean
- `npm run build` — clean, 108 kB gzip main chunk
- dev server boots, renders, **0 console errors**
- `npm run check` — passes: UUID extraction from bare token and from label URL, rejection of a
  damaged code, `parseDbError` on `FEFO_VIOLATION` / duplicate key / unknown, HU qty split
  (including `huCount = 0` not producing Infinity), FEFO override reason ≥ 8 chars,
  permanent-vs-retryable outbox error classification

**Not verified:** anything requiring a live database — every screen past login is untested against
real data. That is the first job of the next session.

---

## 7. Known gaps, in priority order

1. **No Supabase project.** Nothing runs past the setup screen until §8 is done.
2. **`neotrace_schema.sql` (v1) is missing from the source folder.** Blocks everything. Ask the user.
3. **Trace screen renders raw JSON** for `v_trace_forward`, `traceBackward`, and
   `v_consignment_balance`, because those view shapes are defined in the v1 schema nobody has.
   Marked with a `ponytail:` comment in `Trace.tsx`. Turn into real column tables once v1 lands.
4. **Backward trace takes a batch UUID typed by hand.** Needs a batch picker.
5. **Column-name risk.** `queries.ts` was written from the ERD, not from live DDL. Expect a few
   mismatches on first connect — likely suspects: `ccp_definitions.name` / `.uom`,
   `formulas.output_qty`, `production_batches` status enum values
   (`PLANNED` / `IN_PROGRESS` / `QC_HOLD` / `CLOSED`), `allergens.name_id`, `locations.name`.
6. **Label size 50 × 30 mm is a guess** (`LABEL_MM` in `lib/labels.ts`). Plan task T09 says decide
   the printer and sticker size first. Print one, measure, adjust.
7. **Label printing uses `window.open` + `window.print()`.** Popup blockers break it; the error is
   surfaced to the operator. If the site is installed as a PWA this needs a re-test.
8. **Service worker caches nothing.** Offline *recording* works (IndexedDB); offline *cold start*
   does not. Decide if the floor needs it.
9. **No CCP reading history shown** — you can record a reading, not review earlier ones.
10. **QC screen shows the release button to everyone.** Deliberate: the database rejects non-QA and
    the rejection message teaches who is authorised. Confirm the user still wants this after UAT.

---

## 8. Next session — do these in order

1. Get `neotrace_schema.sql` (v1) from the user.
2. Create the Supabase project (staging first). Enable **pg_cron** and **Storage**.
3. Run `neotrace_schema.sql`.
4. Run `neotrace_phase1_delta.sql` in **two batches** — line 23
   (`alter type lot_status add value ... 'BLOCKED'`) must commit on its own before the rest,
   the file says so at line 25.
5. Schedule the daily job:
   `select cron.schedule('neotrace-daily', '5 17 * * *', $$select run_daily_expiry_jobs()$$);`
   (17:05 UTC = 00:05 WIB).
6. Create `.env` in `neotrace-web/` — **the previous session could not write this file, a permission
   rule blocks `.env*`; ask the user to create it or write it yourself if your session permits:**
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```
7. Import master data: items, partners, locations, formulas, allergens, ccp_definitions (T05–T07).
   Without items and formulas the Receive and Production screens are empty shells.
8. Create a test user + row in `profiles` with `role = 'QA'`, then walk the full loop:
   receive → print label → scan → QC release → batch consume (test a FEFO violation on purpose)
   → CCP → close batch → check yield/HPP → trace forward.
9. Fix the column mismatches that surface in step 8 (see gap 5).
10. Then attack gaps 3, 4, 6.

---

## 9. Commands

```bash
cd neotrace-web
npm install
npm run dev        # http://localhost:5173
npm run check      # assert-based self-check, no framework
npm run build      # tsc -b && vite build
```

Dev server is also registered in the parent `.claude/launch.json` as **`neotrace`**
(`npm --prefix neotrace-web run dev`, port 5173) so `preview_start` can drive it.

---

## 10. Conventions to keep

- UI copy in Bahasa Indonesia; comments in Bahasa Indonesia to match the provided files.
- Business rules stay in the database. The frontend translates Postgres exceptions
  (`parseDbError`) into operator language — it never re-implements a rule.
- Never queue a decision the server must make. `resolve_qr` and `release_lot` are online-only,
  by design, documented at the top of `offlineQueue.ts`. Only recording goes in the outbox.
- Any deliberate simplification carries a `ponytail:` comment naming the ceiling and the upgrade path.
- New status colours go through `pill()` / `lotTone()` in `src/ui.ts`, not ad-hoc hex.
- Accent rules are `borderTop`, never a thick left border (project design hook flags side-tabs).
- Files stay under 500 lines (project CLAUDE.md).

---

## 11. Confidentiality

Client NetSuite/Neofood data stays local. Do not push this repo, its master data, or any lot
data to a third-party service. No cloud-sync plugins on client deliverables.
