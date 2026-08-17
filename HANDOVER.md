# NEOTRACE — Handover

**Project:** NEOTRACE web app — PT Neopangan Selaras Indonesia (Neofood), Sauce Division
**Location:** `D:\Pointstar\OneDrive - 明 and Daughters\Team Lead\Testing AI\neotrace-web`
**Updated:** 17 Aug 2026 · **Status:** Fase 1 + Fase 2 + Fase 3 + Fase 4 all live on the staging Supabase project, plus a new Administrator menu (`/admin`) with a WMS role/permission matrix, Excel-upload master data, and new-user creation (§6d, §6f), and a phone/desktop layout split across every screen (§6e). All SQL deltas applied, three cron jobs scheduled, frontend deployed to Vercel with a working SPA rewrite (`vercel.json` — see §6c, this was broken since the first deployment). **Picking and staging (previously gap 2, "untested against live data") are now walked end-to-end — 20 transaction scenarios across GRN/QC/put-away/picking/staging/production/CCP/batch-close/trace, 9 real bugs found and fixed, see §6g.** Put-away was smoke-tested earlier with two real bugs found and fixed (§6a); Waves and all five Analytics tabs smoke-tested clean (§7).

Read this top to bottom before touching code. Everything a new session needs is here.

---

## Live environment

| | |
|---|---|
| Supabase project | `neotrace-staging` — ref `wwghhyeidmxcwjfyhtgn`, ap-southeast-1. v1 + all four phase deltas applied. Three cron jobs scheduled: `neotrace-daily` (00:05 WIB, expiry/halal alerts), `neotrace-abc` (monthly, ABC classification), `neotrace-reclaim` (every 10 min, unstick claimed outbox rows). `neotrace-forecast` deliberately **not** scheduled yet — no real consumption history exists (see gap 1). **This is a staging project, and multiple sessions/people may be testing against it concurrently** — don't assume data you didn't create yourself is spurious, check `created_at` before treating something as a bug. Create a separate project before going to real production data. |
| GitHub | [adhi5758-ops/neotrace](https://github.com/adhi5758-ops/neotrace), branch `main`. **Currently public** — contains no real Neofood business data (schema + fictional placeholder seed only), but exposes app architecture and RLS/trigger logic. Consider making it private. |
| Vercel | [neotrace-web.vercel.app](https://neotrace-web.vercel.app) — project `neotrace-web`, auto-deploys on push to `main` via the GitHub integration (connected directly in the Vercel dashboard, not through the Claude↔Vercel MCP connector — that connector can manage projects but its deployment/list APIs return 403/404 unpredictably; don't waste time on it, use `git push`). Deployment protection is off (public). |
| Admin login | `adhi5758@gmail.com`, `profiles.role = 'ADMIN'` |
| Master data | **placeholder only, not real** — 11 items (7 raw + 4 finished, 2 allergen carriers), 10 partners (6 suppliers, 3 customers, 1 consignment client), 15 locations (racks A1/A2 × L1/L2 + one extra allergen rack, allergen-zoned, 3 staging areas), 2 formulas (6 lines total), 4 CCPs, 1 ERP endpoint (`ERP-SANDBOX`, dummy) — expanded in §6g on top of the original Fase 2 seed. Plus a live 20-transaction mockup dataset (3 lots received, released/held/recalled via QC, put away incl. an allergen-rejection test, 3 batches with 2 fully picked+consumed, 1 closed with real HPP) — see §6g for the full list. Can be bulk-managed via `/admin` → Data induk (§6d) instead of hand-written SQL |
| WMS role/permission matrix | `wms_roles` (6), `wms_modules` (17), `wms_role_permissions` (102) — seeded 1:1 from `wms_roles_permissions_matrix.csv`, editable at `/admin` → Hak akses (§6d) |

To ship a code change: commit locally, then run `git push` from this folder — nobody in this environment has git credentials cached, so pushing always needs a human at the keyboard. Vercel rebuilds automatically. To run SQL against the live project, use the Supabase MCP tools with project id `wwghhyeidmxcwjfyhtgn`.

---

## 1. What this is

A React PWA for lot traceability and warehouse execution on the sauce production floor.
Phone-first for operators (receive, scan, put-away, pick, consume, CCP), same pages on desktop
for QA, warehouse supervisors, and finance (QC release, warehouse map, trace, cost).

| | Fase 1 | Fase 2 | Fase 3 | Fase 4 |
|---|---|---|---|---|
| Goal | Actual HPP per batch · two-way traceability · consignment reconciliation | Eliminate misplacement · faster picking · prevent cross-contamination by system | Warehouse productivity via wave picking; give management usable numbers | Stop double entry between NEOTRACE and ERP; base purchasing on real consumption |
| Scope | v1 schema + QR scan + FEFO + QC hold + expiry alerts | Directed put-away · allergen zoning (hard block) · pick list from formula · staging | Wave/zone/cluster picking · labour sessions & KPI · ABC · turnover · slow moving · ops scorecard | Outbox/inbox · ID mapping · idempotency & retry · sync health · consumption history · seasonality · forecasting · reorder points |
| Go-live | 02 Oct 2026 | 04 Dec 2026 | 19 Feb 2027 (starts 11 Jan, 6 weeks) | 30 Apr 2027 (starts 08 Mar, 8 weeks) |

Still out of scope after Fase 4: cross-docking, packing & SSCC, RFID, dual UoM / catch weight.

> **Strategic decision owed before Fase 3 ends (RAID R41).** If Neofood adopts a full ERP,
> Fase 4 may not need building at all — it would rebuild functions the ERP already has.
> The Fase 4 code below exists, but that decision belongs to PO Neofood, not to the build team.

---

## 2. Source material

All source files now live in this folder alongside the app:

| File | What it is | State |
|---|---|---|
| `neotrace_schema.sql` | v1 core schema — tables, enums, views, `resolve_qr`, `suggest_lots_fefo` | applied to staging |
| `neotrace_phase1_delta.sql` | QC hold, FEFO enforcement, expiry alerts, RLS | applied to staging |
| `neotrace_phase2_delta.sql` | Put-away, allergen zoning, pick lists, staging, console views | applied to staging (incl. the §6a constraint fix) |
| `neotrace_phase3_delta.sql` | Wave picking, labour sessions & KPI views, ABC, turnover, slow moving, utilisation, ops scorecard | applied to staging (incl. the §6b syntax fix) |
| `neotrace_phase4_delta.sql` | ERP outbox/inbox, entity mappings, payload builders, claim/ack/fail, sync health, consumption history, seasonality, forecasting, reorder points | applied to staging |
| `neotrace_admin_delta.sql` | Administrator layer — `wms_roles`/`wms_modules`/`wms_role_permissions`, `profiles.wms_role_id`, RLS gated on `current_role_is('ADMIN')`, seeded from `wms_roles_permissions_matrix.csv` | applied to staging |
| `neotrace_schema_v2_wms.sql` | Older full-WMS draft — **do not run**, phase2 delta supersedes it (its own header says so) |
| `NEOTRACE_Fase1_Rencana_Kerja.xlsx` | 6-week plan, T01–T44 | reference |
| `NEOTRACE_Fase2_Rencana_Kerja.xlsx` | 8-week plan, P01–P43, RACI, RAID, exit criteria | reference |
| `NEOTRACE_Fase3_Fase4_Rencana_Kerja.xlsx` | Fase 3 W01–W23 (6 wk) + Fase 4 E01–E26 (8 wk), RACI, RAID, exit criteria | reference |
| `neotrace_erd.svg` | ERD, Fase 1 vs Fase 2 marked | reference |

Seven modules were supplied as finished code and are used **verbatim** except where §5 says otherwise:
`src/lib/api.ts`, `src/lib/offlineQueue.ts`, `src/lib/api-phase3.ts`,
`src/components/QrScanner.tsx`, `src/components/BatchConsumePanel.tsx`,
`src/components/WavePickSheet.tsx`, and the Deno edge worker
`supabase/functions/erp-sync/index.ts`.

---

## 3. File tree

```
neotrace-web/
  index.html                  font vars (Archivo UI + mono for codes), manifest, icon
  package.json                deps + `npm run check`
  scripts/check.mjs           framework-free assert self-check (Fase 1 + Fase 2)
  public/                     manifest.webmanifest · icon.svg · sw.js (pass-through)
  src/
    main.tsx                  root + SW registration (prod only)
    App.tsx                   auth gate, router, top bar, bottom nav, setup screen
    ui.ts                     colour tokens C, shared styles s, pill(), lotTone()
    lib/
      api.ts                  PROVIDED + config guard (§5)
      offlineQueue.ts         PROVIDED, untouched
      queries.ts              read queries: master, QC, production, trace, console views
      labels.ts               QR labels — handling units + rack locations (P12)
      putaway.ts              FASE 2 — put-away, zoning, transfer, location-code parsing (P13)
      picking.ts              FASE 2 — pick lists, confirm pick, staging (P23)
      api-phase3.ts           FASE 3 — PROVIDED: waves, labour, ABC/turnover/scorecard reads
      labour.ts               FASE 3 — useLabourSession hook, stale-session rules, supervisor board
      api-phase4.ts           FASE 4 — sync health & outbox intervention, forecasts, reorder points
      admin.ts                ADMIN — WMS role/permission matrix + user management queries
      masterData.ts           ADMIN — Excel-upload table config (items/partners/locations) + row coercion
      excel.ts                ADMIN — SheetJS read/write, xlsx dynamically imported (own chunk)
    components/
      QrScanner.tsx           PROVIDED, untouched
      BatchConsumePanel.tsx   PROVIDED, untouched
      WavePickSheet.tsx       FASE 3 — PROVIDED, one import line changed (§5)
      SessionConflict.tsx     FASE 3 — hanging-session banner (W10)
    screens/
      Login.tsx               email/password via supabase.auth
      Home.tsx                tiles + outbox/unread banners
      Scan.tsx                free LOOKUP scan; also serves route /h/:token
      Warehouse.tsx           FASE 2 hub — receive, put-away, picking, staging, console
      Receive.tsx             GRN → lot QUARANTINE → print N QR labels
      Putaway.tsx             FASE 2 — task list, dual scan, deviation reason, free transfer
      Picking.tsx             FASE 2 — route-ordered lines, scan confirm, short pick, override
      Staging.tsx             FASE 2 — occupancy board, assign/release area
      WarehouseConsole.tsx    FASE 2 — rack map, dock-to-stock, pick performance, rack labels
      Qc.tsx                  QC queue, samples, tests, release / hold / recall
      Production.tsx          batch → pick list → requirements → consume → CCP → close + HPP
      Trace.tsx               forward / backward / consignment, all typed columns
      Notifications.tsx       realtime alerts, mark read
      Waves.tsx               FASE 3 — form waves, assign picker, open wave sheet
      Analytics.tsx           FASE 3+4 — scorecard · turnover · labour · forecast · sync (5 tabs)
      Admin.tsx               ADMIN — Pengguna · Hak akses · Data induk (3 tabs), reached from Beranda only if role=ADMIN
  supabase/functions/erp-sync/
      index.ts                FASE 4 — PROVIDED Deno worker; outside src, not in the Vite build
  supabase/functions/admin-create-user/
      index.ts                ADMIN — creates auth.users + profiles rows; only edge function actually deployed so far (§6f)
```

Navigation: bottom tabs are **Beranda · Gudang · QC · Produksi · Telusur**.
Receive/put-away/picking/waves/staging/console all sit under Gudang — six warehouse screens
would not fit in a phone tab bar. Analitik is reached from Beranda, not the tab bar: its readers
are management and planners, who are on desktop and visit it daily at most.

Design language, unchanged from the provided components: square corners, `borderTop` accent
rules (never left side-tabs), monospace for every lot/HU/rack code, palette in `src/ui.ts`
(`ink #0E2A20`, `neo #1B7A4B`, `amber #D0870A`, `chili #C13A22`, `lab #EEF3F0`).
All copy is Bahasa Indonesia — keep it that way, operators read these screens.

---

## 4. Plan task → code mapping

**Fase 1** — T08 shell/auth · T10 API · T11 GRN · T12 labels · T13 scanner · T14 offline queue ·
T17 QC · T18 production+FEFO · T19 CCP · T20 FEFO enforcement (DB): all implemented.
T01–T07 (Supabase provisioning, schema runs, RLS testing, master import, CCP definitions): **not done**.

**Fase 2**

| Task | Where | State |
|---|---|---|
| P09 stock transfer with live zone validation | `Putaway.tsx` "Pindah stok tanpa tugas" | done — same code path as put-away, zoning enforced by trigger |
| P12 rack QR labels | `labels.ts` `printLocationLabels` + console "Label rak" tab | done, needs physical print test |
| P13 put-away API | `lib/putaway.ts` | done |
| P14 put-away task screen | `Putaway.tsx` | done |
| P15 dual scan (package → rack) | `Putaway.tsx` `ScanLocation` | done |
| P16 deviation with mandatory reason | `Putaway.tsx`, gated at 8 chars | done |
| P17 auto-issue tasks on QA release | DB trigger `t_putaway_on_release` | in SQL, not run |
| P21 pick list screen | `Picking.tsx` | done |
| P22 desktop assign console | `WarehouseConsole.tsx` → Picking tab | done |
| P23 picking API | `lib/picking.ts` | done |
| P25 scan confirm + right-item check | `Picking.tsx` + DB `WRONG_ITEM` | done |
| P26 short pick & FEFO override | `Picking.tsx` | done |
| P27 staging screen | `Staging.tsx` | done |
| P28 pick list → batch consumption | `Production.tsx` `PickListPanel` | done |
| P30 warehouse occupancy map | `WarehouseConsole.tsx` → Peta rak | done |
| P31 dock-to-stock & compliance | `WarehouseConsole.tsx` → Dock-to-stock | done |
| P32 picking performance | `WarehouseConsole.tsx` → Picking | done |

P01–P08, P10, P11, P19, P24, P33–P43 are data, physical, process, training, or ops tasks — not code.

**Fase 3**

| Task | Where | State |
|---|---|---|
| W05 generate_wave for 3–5 batches | DB function | in SQL, not run |
| W06 desktop console: form wave, pick batches, assign | `Waves.tsx` `FormWave` + `AssignPicker` | done |
| W07 phone wave sheet, one stop per rack, split to totes | `components/WavePickSheet.tsx` (PROVIDED) hosted by `Waves.tsx` | done |
| W09 clock in/out folded into pick & put-away | `lib/labour.ts` `useLabourSession`, wired in `Picking.tsx` + `Putaway.tsx` | done |
| W10 hanging sessions & one open session per person | `useLabourSession` adopt-or-conflict + `SessionConflict.tsx` | done |
| W11 supervisor board: who is doing what now | `Analytics.tsx` → Tenaga kerja tab | done |
| W13 turnover, days on hand, slow moving | `Analytics.tsx` → Perputaran | done |
| W14 warehouse utilisation & ops scorecard | `Analytics.tsx` → Scorecard | done |
| W15 labour KPI & wave performance | `Analytics.tsx` → Tenaga kerja | done |

**Fase 4**

| Task | Where | State |
|---|---|---|
| E06 sync worker with claim/ack/retry | `supabase/functions/erp-sync/index.ts` (PROVIDED) | **not deployed** |
| E10 sync health monitor in admin console | `Analytics.tsx` → Sinkronisasi | done |
| E15 run forecast & backfill actuals | `Analytics.tsx` → Peramalan buttons | done |
| E16 forecast & reorder suggestion screen | `Analytics.tsx` → Peramalan | done |
| E20 DEAD message manual intervention | `api-phase4.ts` `requeueMessage` / `skipMessage` + Sinkronisasi tab | done |

E01–E05, E08, E09, E11, E12, E14, E17–E19, E21–E26 are contract, integration, data, or ops
tasks needing the ERP team — not frontend code.

---

## 5. Changes made to provided code

`src/lib/api.ts`, top of file. The original called `createClient(import.meta.env.VITE_SUPABASE_URL, ...)`
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

`App.tsx` reads `isConfigured` and renders a setup screen instead.

**Change 2 — `src/components/WavePickSheet.tsx`, one import line.** The provided file imported
`confirmPick` from `../lib/api-phase2`, a module name this codebase never used (Fase 2 lives in
`lib/putaway.ts` + `lib/picking.ts`). Changed to `import { confirmPick } from '../lib/picking'`.
Nothing else in that file was touched.

To make that work, `picking.ts`'s `confirmPick` was switched from an object argument to
**positional** `confirmPick(lineId, huId, qty, overrideReason?, scanEventId?)`, matching how the
provided component calls it. `Picking.tsx` was updated to the same signature — there is now one
`confirmPick`, not two.

`api-phase3.ts` and `supabase/functions/erp-sync/index.ts` are byte-identical to what was supplied.
The design hook flags three cosmetic issues inside `WavePickSheet.tsx` (two left-border accents and
a `width` transition on the 4px progress bar) — left alone deliberately, they are the author's
choices in supplied code and cost nothing at that size.

---

## 6. Fase 1 bugs found and fixed against the real v1 schema

The v1 schema arrived after Fase 1 was written, so `queries.ts` had been built from the ERD.
Four mismatches were confirmed and corrected:

1. `production_batches.status` enum is `PLANNED / RUNNING / QC_HOLD / CLOSED / CANCELLED` —
   the code filtered on `IN_PROGRESS`, which does not exist. Open batches were silently missing.
2. `partner_type` includes `BOTH`. `listPartners` used `.eq('type', …)`, hiding any partner who is
   both supplier and customer. Now `.in([type, 'BOTH'])`.
3. `ccp_definitions.item_id` is nullable, meaning "applies to every SKU". The code filtered
   `.eq('item_id', …)`, so global CCPs never appeared. Now `.or(item_id.eq.X, item_id.is.null)`
   plus an `is_active` filter, and the real `parameter` column is selected.
4. `formula_lines.sequence` exists and defines line order; requirements now order by it.

Also resolved: `v_trace_forward`, `v_consignment_balance` and backward trace no longer dump raw
JSON — real columns, grouped by batch and by customer. Backward trace uses a batch dropdown
instead of a hand-typed UUID.

---

## 6a. Fase 2 bugs found and fixed during live smoke-testing

Both surfaced walking the real receive → release → put-away path against the live database
(nobody had exercised this against real Postgres before):

1. **`Staging.tsx` filtered locations by `type === 'STAGING'`** instead of the `is_staging`
   boolean. This let an operator pick `STG-01` (a Fase 1 location with `type=STAGING` but
   `is_staging=false`) from the assign dropdown, which `assign_staging()` would then reject with
   `NOT_A_STAGING_LOCATION`. Fixed to filter on `is_staging`; `queries.ts` `Location` now selects
   and types that column.
2. **`complete_putaway()` inserted `qty=0` into `stock_movements`**, which is the *correct* value —
   `trg_apply_movement_to_hu` (from v1) applies `qty` as a delta to `handling_units.qty_remaining`,
   and a pure location move has zero quantity delta — but v1's `chk_qty_nonzero` constraint
   (`check (qty <> 0)`) rejected it outright, and rejected it a second way: an earlier fix attempt
   that set `qty` to the actual quantity moved passed the constraint but then got double-counted by
   the delta trigger, tripping `chk_hu_remaining`. The real fix was loosening the constraint:
   `check (qty <> 0 or type = 'TRANSFER')`. Both the live DB and `neotrace_phase2_delta.sql` are
   updated — a fresh run of the delta file now includes this from the start.

If Fase 2 goes to a fresh Supabase project, `neotrace_phase2_delta.sql` as currently checked in
already has both fixes baked in. If you're diffing against an older copy of that file, these are
the two things that changed.

---

## 6b. Fase 3 SQL syntax error found while applying the delta

`v_labour_kpi` and `v_putaway_productivity` both had a bare (unquoted) `day` column alias
immediately after a function call — e.g. `date_trunc('day', ls.started_at at time zone
'Asia/Jakarta') day`. Postgres rejected it with `syntax error at or near "day"`. The identical
pattern with `week` (already live in Fase 1/2's `v_fefo_compliance` and `v_putaway_compliance`)
works fine, so this is specific to `day`, not bare aliases in general — not fully root-caused,
just worked around by adding an explicit `AS day`. Both the live DB and
`neotrace_phase3_delta.sql` are fixed. If you hand-write a new view with a bare date-part alias,
prefer `AS <name>` on principle rather than relying on it being safe.

---

## 6c. Production bug found verifying the Vercel deployment: QR scan-to-open was broken

No `vercel.json` existed, so Vercel had no rewrite rule sending unmatched paths to `index.html`.
Client-side routing worked fine for in-app navigation (clicking links never leaves the loaded
page), but any **direct** load of a deep route — a bookmark, a page refresh, or a link opened from
outside the app — hit Vercel's own 404 instead of the React app. This was caught by chance while
verifying the Fase 3/4 deployment (`/analitik` 404'd on direct navigation) and turned out to be far
more serious than a refresh edge case: **`/h/:token` is the exact URL `labels.ts` prints inside
every QR code label**, and a phone camera opens that URL directly, completely outside the SPA's
own router. Scan-to-open — the core interaction the whole app is built around — has been broken in
production since the very first deployment, and nobody had tested it because every prior session
verified via in-app navigation or `localhost`, never a cold direct hit on the deployed URL.

Fixed with the standard Vercel SPA catch-all in `vercel.json`:
```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```
Verified in a fresh browser tab with no prior app state, hitting `/h/:token` directly — landed on
the Scan screen and resolved the token correctly. Static assets under `/assets` etc. are unaffected
since Vercel checks disk before applying rewrites.

**Lesson for future verification:** "the app works" claims from in-app click-through are not
equivalent to "the deployed site works" — always test at least one deep link via direct
navigation/fresh tab against the actual production URL, not just `localhost` or link-clicking.

---

## 6d. Administrator menu — WMS role/permission matrix, master data Excel upload (16 Aug 2026)

Built from `wms_roles_permissions_matrix.csv` (supplied this session), on request: an
Administrator menu covering (1) user role management, (2) a data-driven WMS permission matrix,
(3) Excel/CSV bulk upload for master data with a downloadable template.

**Design decision — additive, not a rewrite.** The matrix from the CSV (6 roles × 17 modules,
4 permission levels) does not map onto the existing `profiles.role` enum (`OPERATOR/WAREHOUSE/
QA/PLANNER/FINANCE/ADMIN/VIEWER`), which every RLS policy in the app already depends on. Rather
than risk that enum, the matrix lives in three new tables — `wms_roles`, `wms_modules`,
`wms_role_permissions` (composite PK `role_id, module_id`) — plus a nullable
`profiles.wms_role_id` FK. `profiles.role` still gates all existing RLS; `wms_role_id` is purely
informational/UI-driven for now (no RLS policy reads it yet — see gap 18). All three new tables
are readable by any active user and writable only by `current_role_is('ADMIN')`, reusing the
function that already gates every other admin-only policy in the schema.

**Master data upload.** `items`/`partners`/`locations` already existed since Fase 1/2; nothing
new in the schema. `/admin` → Data induk lets an admin pick a table, download a template
(header row + one example row), and upload a filled `.xlsx`/`.xls`/`.csv` back — parsed
client-side with SheetJS, coerced (blank → `null`, `'true'/'false'` strings → real booleans for
columns like `requires_halal_cert`, `is_staging`), then `upsert()`'d on the table's natural code
column (`items.code`, `partners.code`, `locations.code`). No file ever leaves the browser except
straight to Supabase's PostgREST endpoint.

**xlsx supply-chain note.** The npm-registry `xlsx@0.18.5` carries HIGH-severity advisories
(prototype pollution, ReDoS). Installed instead from SheetJS's own patched distribution:
`npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. It's also dynamically
imported inside `lib/excel.ts` (`await import('xlsx')`), not imported at module top — a static
import doubled the main bundle (559 kB → 1062 kB raw); dynamic import puts it in its own
163 kB-gzip chunk that only loads when the Data induk tab is actually opened, keeping the main
chunk back down around 164 kB gzip.

**Live-verified against the staging Supabase project:**
- `wms_roles`/`wms_modules`/`wms_role_permissions` row counts confirmed 6/17/102, matching the CSV.
- Switched the role selector to **System Administrator** and confirmed "Operational Dashboards"
  correctly shows **Lihat saja (VIEW_ONLY)** — the single non-FULL_CONTROL cell for that role in
  the whole matrix — proving the seed transcribed the CSV exactly, not just row/column counts.
- Full upload round-trip: synthesized a CSV file in-browser, uploaded through the real
  `<input type="file">`, confirmed the UI showed "1 baris diunggah" and the new row appeared;
  then checked directly in Postgres that `requires_halal_cert` landed as a genuine `boolean`
  (`pg_typeof` confirmed, not a string), `standard_cost` as `numeric`, and the blank
  `shelf_life_days` cell as real `null`. Test row deleted afterward — `items` is a catalog other
  screens browse, unlike lot/transaction test data left in place elsewhere in this project as
  evidence.
- Verified `/admin` on the **live production URL** (`neotrace-web.vercel.app/admin`, not just
  `localhost`), logged in as the real admin account — renders identically to dev, zero console
  errors.

No bugs found this pass — `npm run check` and `npm run build` were both clean on the first
attempt once the dynamic-import fix landed.

---

## 6e. Phone/desktop layout split (16 Aug 2026)

Every screen used the same phone-first container (`s.page`, 760px max-width) regardless of
viewport — fine for the three screens operators actually scan with (Pindai label, Put-away,
Pick list), wasteful everywhere else once a supervisor/QA/planner opens the app on a laptop.

**Design.** `src/ui.ts` gained three tokens:
- `s.pageWide` (1400px max-width) — for the dashboard/console screens: Beranda, Gudang hub,
  Staging, Konsol gudang, Gelombang, Analitik, QC, Produksi, Telusur, Notifikasi, Monitor, Admin.
- `s.pageForm` (900px max-width) — for Terima (a long form screen; wide-open edge-to-edge
  inputs read worse than a comfortably centered column, unlike a list of independent cards).
- `s.cardGrid` — `grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))`. Every screen's
  card lists (queues, KPI tiles, occupancy boards, permission matrices, etc.) now wrap in this
  instead of stacking full-width — more rows fit on screen without inventing per-screen
  breakpoints. **Use `auto-fit`, not `auto-fill`**, for this pattern: `auto-fill` leaves a
  trailing empty-track gap when a section has fewer cards than would fill a row (found live —
  Admin's REPORTING category with only 2 modules left one card at 330px with dead space next to
  it instead of stretching to fill the row); `auto-fit` collapses empty tracks so existing cards
  stretch to fill.
- **Pindai label, Put-away, and Pick list keep `s.page` untouched** — verified their content
  container stays exactly 760px even at a 1440px browser width. These are the phone-in-hand
  scanning flows; widening them was explicitly out of scope.

**Navigation.** A new `DeskNav` in `App.tsx` (Beranda · Gudang · QC · Produksi · Telusur ·
Analitik) shows above 900px width, replacing the thumb-sized bottom tab bar, which hides at
that width. Both are always in the DOM; a CSS media query in `index.html` toggles which one
is visible. **Gotcha:** both navs set `display` via inline React `style`, and inline styles
beat a plain stylesheet rule regardless of selector specificity — the media query needed
`!important` on both `display` declarations or it silently did nothing (caught live: the
bottom nav stayed `display: grid` at 1440px until this was added).

**Bug found and fixed during verification — `/notifikasi` crashed with a white screen.**
`subscribeNotifications()` (`lib/api.ts`) always opened a Supabase Realtime channel named
`'notif'`. `App.tsx` subscribes once globally (for the header's unread badge) and
`Notifications.tsx` subscribes again on its own mount (to refresh its list) — two independent
subscriptions to the *same* channel topic. Supabase's client throws ("cannot add
`postgres_changes` callbacks for realtime:notif after `subscribe()`") the moment the second
subscription tries to attach a listener to a topic the first already subscribed, which crashes
the whole `<App>` tree since nothing catches it. Confirmed this was **not** a React 18
StrictMode dev-only artifact — it reproduced identically against a `vite build` + `vite preview`
production bundle with a real login. Fixed by giving each call a unique topic
(`` `notif-${Math.random().toString(36).slice(2)}` ``); both subscriptions now get their own
channel and neither collides. This bug predates this session (the subscription code itself
wasn't touched) and was purely a byproduct of two different files subscribing independently —
worth knowing if a third screen ever adds its own `subscribeNotifications()` call.

Verified live: every non-phone screen at 1440px width shows `pageWide`/`pageForm` containers and
populated `cardGrid`s (checked Beranda, Konsol gudang, QC, Produksi, Telusur, Admin incl. its
Hak akses tab's category grouping); Pindai/Put-away/Pick list confirmed still 760px at the same
width; mobile viewport (375px) confirmed bottom nav visible, desktop nav hidden, grids collapse
to one column; `/notifikasi` confirmed non-crashing on both `localhost:5173` and the deployed
`neotrace-web.vercel.app`. `npm run build` and `npm run check` both clean.

---

## 6f. New-user creation added to `/admin` (16 Aug 2026)

Closes gap 19 below — `/admin` → Pengguna previously said outright that new accounts had to be
created via the Supabase dashboard. `auth.admin.createUser()` needs the service role key, and
that key must never reach the client bundle, so this needed a server-side piece.

**Added `supabase/functions/admin-create-user`** (Deno edge function, first edge function
actually deployed this project — `erp-sync` from Fase 4 still isn't, per gap 0). Deployed with
`verify_jwt: true` (the Supabase gateway rejects any request without a valid session before the
function's own code runs at all), and the function does a *second*, more specific check inside:
it builds a client scoped to the caller's own JWT (anon key + `Authorization` header), reads
that caller's own `profiles` row through normal RLS (`p_profile_self`), and refuses unless
`role = 'ADMIN'` and `is_active`. Only after both gates pass does it touch a service-role client
to call `auth.admin.createUser({ email, password, email_confirm: true })` — `email_confirm:
true` is deliberate, this is an internal ops tool with no public signup flow, so there's no
"click the link we emailed you" step to wire up. It then inserts the matching `profiles` row
itself (full_name, employee_no, department, role, wms_role_id) using the same service-role
client; if that insert fails (e.g. duplicate `employee_no`, which is `unique`), it deletes the
auth user it just created rather than leaving an orphaned login with no profile.

`lib/admin.ts` gained `createUser(input)`, calling `supabase.functions.invoke('admin-create-user',
...)`. The tricky part: `functions.invoke()` puts the HTTP error on `error`, not `data`, and the
actual `{error: "..."}` JSON body from the function lives on `error.context` (a `Response`) —
had to `await error.context.json()` to surface the real message instead of a generic "Edge
Function returned a non-2xx status code".

**UI** (`Admin.tsx`): a "+ Tambah pengguna baru" button opens a form (name, email, initial
password with a "Acak" button that generates one via `crypto.getRandomValues`, optional employee
no./department, app role, WMS role). On success the email + password are shown once in a plain
callout — not emailed anywhere, the admin is expected to hand them to the new employee directly,
consistent with how this factory-floor tool already operates (shared devices, supervisor-issued
logins, not self-service signup).

**Verified live end-to-end**, not just deployed: created a real test account through the actual
UI, confirmed the row landed correctly in both `auth.users` (email pre-confirmed) and `profiles`
(right full_name/role/is_active, employee_no/department correctly null when left blank) via
direct SQL, confirmed a `curl` call with no `Authorization` header gets `401` before the function
body runs at all, then deleted the test account from both tables. Deployed and pushed; production
Vercel build shows the button and opens the form correctly.

**Still true after this:** gap 19's other half (new *auth* users can't self-serve, someone with
ADMIN has to do this) is now solved from inside the app instead of needing the Supabase
dashboard, but it's still ADMIN-gated, deliberately — this isn't a public registration page.

---

## 6g. Dummy dataset + 20-transaction live walkthrough — 9 real bugs found and fixed (17 Aug 2026)

Closes gap 2 ("picking and staging are untested against live data") and most of gap 0's picking
half. Requested: 10 dummy master-data records covering every part of the transaction mockup, plus
20 transaction types walking every scenario the app models, with manual testing wherever something
broke. It broke a lot — this staging project had **never actually been walked through discrete
picking, CCP recording, or batch-close before**, and it showed.

**Dummy data added** (on top of the existing 3 items/3 partners/13 locations): 8 items (own to 11 —
`RM-BWP-001` Bawang Putih, `RM-CUK-001` Cuka, `RM-GAR-001` Garam, `RM-TEP-001` Tepung Maizena,
`RM-KEC-001` Kecap Konsentrat *(allergen carrier: SOY+WHEAT)*, `RM-MIN-001` Minyak Sawit,
`FG-STK-1KG` Saus Tomat, `FG-KCM-600ML` Kecap Manis *(allergen carrier)*), 7 partners (own to 10 —
4 new suppliers, 2 new customers, 1 `BOTH`-type consignment client), 2 new locations (own to 15 —
one more allergen-only rack, one more staging area), a second formula (Kecap Manis, 4 lines) with
2 more CCPs, 4 `item_allergens` links, and 1 `integration_endpoints` row (needed before any ERP
outbox scenario is even possible — there were zero before this).

**20 scenarios walked live** through the actual UI (not raw SQL) wherever the flow has real
frontend logic: 3× GRN (own-goods non-allergen, own-goods allergen-tagged, consigned-goods),
QC sample+release, QC sample+hold-on-FAIL, QC recall/quarantine-cascade, put-away via suggested
rack, put-away with deviation+reason, put-away allergen-zone **rejection** (deliberately walked
into the hard block to confirm it still fires), free stock transfer, pick-list generation from
formula, FEFO-compliant pick, FEFO-override pick, short pick, staging assign, staging release,
CCP reading in-spec (PASS), CCP reading out-of-spec (FAIL + corrective action), consume-from-pick
→ close batch → HPP, forward trace, backward trace — plus a consignment-balance spot check.

**Bugs found and fixed, in the order they surfaced:**

1. **QC text-spec tests could never resolve PASS/FAIL.** `trg_eval_qc_test()` only evaluated
   `result_num` against `spec_min`/`spec_max` — a test with only `spec_text` (any organoleptic
   check: aroma, colour, appearance) stayed `PENDING` forever, which permanently blocks
   `release_lot()`. Added a text-comparison branch (case/whitespace-insensitive). Fixed in the live
   DB and in `neotrace_phase1_delta.sql`.
2. **Recall's detailed impact message was dead code.** `Qc.tsx`'s `run(fn, okText)` helper always
   overwrote whatever `setMsg()` the caller's `fn` set, with the generic `okText`, immediately
   after `fn` resolved. Only the Recall handler tried to show something more specific
   (`N lot produk jadi dan M batch dikunci`) — it was provably unreachable. `run()` now accepts an
   optional `{tone, text}` return value from `fn` and uses that when present.
3. **Rapid consecutive allergen-tag clicks on Terima overwrote each other.** `Receive.tsx`'s
   allergen toggle computed the next array from the outer `f.allergenIds` closure, not from the
   updater's own `p` — two toggles landing in the same React batch (confirmed with two synchronous
   `.click()` calls) silently dropped the first one. Rewrote as a proper functional update
   (`toggleAllergen`, computed entirely inside `setF(p => ...)`).
4. **`confirm_pick()` couldn't complete a single pick line.** `status = CASE WHEN … THEN
   'COMPLETED' ELSE 'SHORT' END` assigned to a `pick_status` column throws `column "status" is of
   type pick_status but expression is of type text` — Postgres resolves an all-literal `CASE` as
   `text` before it ever looks at the assignment target. This is **the** reason picking had never
   been exercised: every single `confirmPick()` call from the UI failed immediately. Added
   `::pick_status` casts to both `CASE` expressions in the function (pick line status, and pick
   list status). Fixed live and in `neotrace_phase2_delta.sql`.
5. **CCP readings had no evaluation path at all** — worse than #1, `ccp_readings` never had *any*
   trigger, numeric or text. Every CCP reading recorded through the app (temperature, Brix, any
   critical limit) stayed `PENDING` forever — a real ISO 22000 gap, since a genuinely out-of-spec
   critical reading would never surface as FAIL or force `corrective_action`. Added
   `trg_eval_ccp_reading()` (numeric-only, matching what `ccp_definitions` actually models — it has
   no text-spec column). Fixed live and in `neotrace_schema.sql`.
6. **`notifications` had no INSERT policy at all** — only read + update. `consumeLot()` writes
   directly to `batch_consumption` via PostgREST (not an RPC), so its `trg_check_consumption`
   trigger runs under the calling user's own RLS context, not a security-definer bypass. The
   trigger's FEFO-override notification insert failed with a bare RLS violation, silently killing
   that one `batch_consumption` row (others in the same batch still succeeded — Production.tsx's
   `consumeFromPick` catches per-row errors). Added `p_insert_notifications` (any active
   authenticated user, mirroring the existing read policy's permissiveness).
7. **"Catat konsumsi dari pick list" was not actually idempotent**, despite its own doc comment
   claiming otherwise ("Sudah tercatat → dilewati"). `pickedLines()` returns every COMPLETED/SHORT
   line unconditionally; retrying after a partial failure (exactly what bug #6 caused) would have
   recorded the already-succeeded lines a second time — silently doubling their cost/quantity in
   HPP. Added `consumedHuIds(batchId)` and filter picked lines against it before the retry loop.
8. **`searchLots()` (Telusur → Lot → produk) has never worked.** `.or('lot_code.ilike…,
   items.name.ilike…, items.code.ilike…')` mixes a local column with embedded-table columns in one
   flat PostgREST `or()` string — not supported, fails with "failed to parse logic tree" on every
   call. Rewrote as two parallel queries (own-column `ilike`, and `.or(..., {referencedTable:
   'items'})` for the embedded columns) merged client-side.
9. **Masked by #8 until it was fixed**: `partners(name)` embedded off `lots` is ambiguous —
   `lots` has two FKs to `partners` (`supplier_id`, `owner_partner_id`) and PostgREST refuses to
   guess. Same bug existed in `traceBackward()` (Batch → bahan), just never reached because search
   always failed first. Both now specify `partners!lots_supplier_id_fkey(name)` explicitly.

**Every scenario passed after its fix**, re-verified through the actual UI (not just re-run via
SQL) except where noted inline. The dummy dataset and all 20 transactions are left in the database
deliberately — this is the mockup the request asked for, not disposable test fixtures, so nothing
was cleaned up this time (unlike the isolated one-off test rows from earlier sessions, e.g. §6d's
`RM-TEST-999`).

**New/updated Known gaps** (numbering continues below): gap 2 is resolved. Gap 0's discrete-picking
half is resolved; wave-picking (`generate_wave`, in-wave `confirm_pick`) and the ERP outbox worker
remain genuinely unexercised — no second/third batch was left free to form a wave with in this
pass. Added below as gap 20.

---

## 7. Verification done

- `npx tsc -b` — clean
- `npm run build` — clean (two chunks, 108 kB + 151 kB gzip; the >500 kB raw warning is the
  zxing scanner fallback, already lazy-imported by the provided `QrScanner.tsx`)
- dev server boots and renders, **0 console errors** (two React Router v7 future-flag advisories only)
- `npm run check` — passes: UUID extraction, DB-error parsing, HU qty split, FEFO reason gate,
  outbox permanent-vs-retryable classification, **rack-code parsing incl. rejecting a package QR
  scanned as a rack**, put-away deviation reason gate, short-pick status, formula→pick-list scaling with scrap
- **Live smoke test against the real Supabase project** (15 Aug 2026): logged in as admin,
  confirmed all four warehouse screens (Put-away, Pick list, Staging, Konsol gudang) render with
  zero console errors against real (placeholder) data. Ran a full receive → QC release → put-away
  cycle: receipt created a QUARANTINE lot, release triggered `trg_putaway_on_release` which
  auto-issued a put-away task, `suggest_putaway` correctly recommended the non-allergen rack for a
  non-allergen item, and `complete_putaway` moved the handling unit and logged the transfer — two
  bugs surfaced and were fixed in the process (§6a). The rack map (`v_warehouse_map`) also
  confirmed correct against real data.

**Not yet verified live:** picking (`generate_pick_list_from_batch`, `confirm_pick`) and staging
assignment (`assign_staging`) — only put-away was walked end-to-end. Given put-away surfaced two
real bugs, treat picking/staging as similarly untested until someone actually clicks through them
against live data.

### Fase 3 + 4 verification (15 Aug 2026)

- `npx tsc -b` and `npm run build` — clean (two chunks, 108 kB + 160 kB gzip)
- dev server renders every route, **0 console errors**; the login gate is reached, so the app is
  talking to the live Supabase project
- `npm run check` — passes, now including Fase 3/4 assertions: stale-session threshold at 8 hours
  (both sides of the boundary), tote codes unique per wave (RAID R33), the 12-period gate before
  reorder advice is shown (R44), reorder-level arithmetic incl. the zero-forecast case, and a
  guard asserting `requeueMessage` never rewrites `idempotency_key` (R42 — that key is the only
  thing stopping a retry from creating a second ERP document)

### Fase 3 + 4 live verification (15 Aug 2026, later same day)

Both deltas applied to staging (§6b fix needed along the way), three cron jobs scheduled, then
smoke-tested against the live DB while logged in as admin:

- `/gelombang` (Waves) — empty state renders correctly, no PostgREST errors
- `/analitik` (Analytics) — all five tabs checked: Scorecard, Perputaran, Tenaga kerja, Peramalan,
  Sinkronisasi. All render real computed numbers with zero console errors.
- `classify_abc()` exercised via its UI button — correctly classified items with no movement
  history as class C, and correctly left `RM-CBM-001` unclassified because it has one
  `stock_movements` row (the put-away transfer from §7's Fase 2 test) inside the fallback's
  365-day window — the "no usage" exemption only applies to items with zero movements of *any*
  type, not zero *issue* movements, which is a subtlety worth knowing but not a bug.
- Confirmed this staging project is shared across concurrent sessions: two handling units existed
  that this session didn't create (`LOT-2608-0001` a finished-good unit, `LOT-2608-0002` a second
  cabai lot at a different unit cost). The scorecard's inventory value initially looked wrong
  (Rp 16,920,000 for what seemed like one Rp 1.8M lot) until checking `created_at` on
  `handling_units` showed the other two predated anything this session did. Not a bug — a reminder
  to verify before assuming, per this project's own "Live environment" note above.

**Zero bugs found in Fase 3/4** this pass — contrast with Fase 2's put-away, which surfaced two
real bugs the moment it was actually exercised (§6a). That contrast is itself informative: it does
not mean Fase 3/4 is more correct, only that the parts exercised so far (empty-state rendering,
one classification RPC) are shallower than put-away's full write path. `generate_wave`,
`confirm_pick` inside a wave, `enqueue_sync`/`claim_outbox`/`ack_outbox`, and
`forecast_moving_average` are all still unexercised against live data — treat them with the same
suspicion put-away deserved before it was tested.

---

## 8. Known gaps, in priority order

0. **`generate_wave`, in-wave `confirm_pick`, the ERP outbox worker functions
   (`enqueue_sync`/`claim_outbox`/`ack_outbox`/`fail_outbox`), and `forecast_moving_average` are
   all unexercised against live data.** Discrete `confirm_pick` (outside a wave) **is** now
   exercised — see gap 2, resolved — and turned up a real bug (§6g #4) that would have hit wave
   picking identically, since in-wave picking calls the same `confirm_pick()` function. Still
   genuinely untested: `generate_wave` itself, and everything Fase 4 (outbox/ERP sync). Both
   deltas are applied and the read-only screens (Waves list, all five Analytics tabs) render
   correctly, but nothing has actually written through these specific paths yet. Also: the
   `erp-sync` edge function is not deployed and has no `ERP_BASE_URL` / `ERP_TOKEN` secrets, so the
   outbox will fill and never drain — expected until an ERP sandbox exists (RAID A41/A42: nobody
   has confirmed the target ERP even accepts inbound documents). A `integration_endpoints` row now
   exists (`ERP-SANDBOX`, dummy `base_url`, §6g) so at least `enqueue_sync` has somewhere to enqueue
   to next time someone picks this up — it still won't actually send anywhere.
1. **Master data is placeholder, not real.** Items, suppliers, formula, and rack layout are all
   fictional test data seeded this session — see "Live environment" above. Real PT Neopangan data
   (items, partners, locations, formulas, allergens, `ccp_definitions`, and the Fase 2 location
   attributes: `rack_code`, `level_no`, `position_no`, `max_weight_kg`, `max_hu_count`,
   `allergen_policy`, `pick_sequence`, `is_staging`) still needs importing (T05–T07, P01–P06).
   Also fill `items.weight_per_uom_kg` for every real item or rack capacity checks silently treat
   1 kg per unit.
2. ~~Picking and staging are untested against live data.~~ **Resolved (§6g, 17 Aug 2026)** — full
   discrete picking (`generate_pick_list_from_batch` → `confirm_pick`, incl. a deliberate short
   pick and a deliberate FEFO override) and staging assign/release walked live through the actual
   UI. Turned up 6 of the 9 bugs fixed in §6g, the most serious being #4 (picking could not
   complete a single line at all before the fix — every `confirm_pick()` call failed).
3. **Column-name risk remains for the parts of Fase 2 not yet live-tested** — `queries.ts`/
   `putaway.ts`/`picking.ts` were written from `neotrace_phase2_delta.sql`, which is exact, so risk
   is low, but put-away's two bugs (a frontend query filtering the wrong column, and a DB constraint
   conflict between the v1 schema and Fase 2 logic) show static review isn't sufficient. The specific
   residual risk flagged before live-testing: PostgREST FK-alias naming in `picking.ts` `pickLines()`
   (`lots!pick_list_lines_suggested_lot_id_fkey`) — correct for Postgres default constraint names,
   but verify when picking is actually exercised.
4. **Rack QR labels reuse the 50 × 30 mm sticker** (`LABEL_MM` in `labels.ts`). Fase 2 racks may
   want a bigger label — the code is printed at 13pt so it reads from a distance, but confirm with
   a physical print (P12, and RAID R15 says use synthetic stock for wet areas).
5. **Allergen zoning has no audit mode in the UI, and the trigger is already live** in the staging
   database (`t_hu_location_guard` is active — this session's put-away test exercised it, though
   with no conflicting stock to actually trigger a rejection). RAID R11 requires running an audit of
   existing stock *before* the hard block goes live against real inventory. Before pointing this app
   at real production stock, either audit existing placements first or hold the trigger back until
   P10/P11 relocation is finished.
6. **Pick list assumes `formula_lines.sequence` and `suggest_lots_fefo` return usable rows.**
   `generate_pick_list_from_batch` raises `NO_STOCK` when nothing is released — surfaced to the user,
   but there is no "partial pick list" path.
7. **No CCP reading history**, no put-away task reassignment UI, no pick list cancel button in the UI
   (the API exists: `cancelPickList`).
8. **Service worker caches nothing.** Offline *recording* works (IndexedDB outbox); offline
   *cold start* does not.
9. **QC screen shows the release button to everyone.** Deliberate — the database rejects non-QA and
   the rejection message teaches who is authorised. Confirm after UAT.
10. **The GitHub repo is public.** See "Live environment" above — no real client data in it, but
    worth a deliberate decision rather than an accident.
11. **Wave picking has no measured baseline yet (RAID R31, W01).** The plan makes W01 the first
    task of Fase 3 for a reason: without before-numbers, "wave picking is faster" cannot be
    proven, and the exit criteria demand proof. Discrete picking stays fully available in
    `Picking.tsx` as the fallback — do not remove it.
12. **`generate_wave` reuses an existing pick list if the batch has one**, otherwise it creates
    one. So a batch already picked discretely can still be pulled into a wave. Nothing prevents
    that today; watch for it during UAT.
13. **Labour sessions are screen-scoped.** Leaving the screen closes the session, so a picker who
    backgrounds the browser mid-aisle ends their own session; reopening starts a new one and the
    old one is adopted only if the reference matches. Sessions older than 8 hours are flagged as
    hanging and can be force-closed from the Tenaga kerja tab. Nobody has watched what this does
    across a real shift.
14. **`reorder_points` is empty and nothing fills it.** The Peramalan tab shows nothing useful
    until a planner sets lead time and safety stock per item (E17). `upsertReorderPoint` exists in
    `api-phase4.ts` but has no UI — deliberate, that data belongs to the planner, not a dev.
15. **No `entity_mappings` management UI.** E05 maps items/partners/locations to ERP IDs; it is
    integrator data-entry work, currently SQL-only.
16. **`v_slow_moving` flags freshly-received stock as "9999 hari"** if it has never been
    issued/shipped/picked — it computes days-since-movement from `stock_movements` filtered to
    `ISSUE/SHIPMENT/PICK` only, so a lot received five minutes ago with no outbound movement yet
    reads identically to genuinely dead stock. Not wrong given the view's definition (it answers
    "has this ever left the warehouse", not "how old is it"), but it will look alarming on a
    freshly-seeded or freshly-received item — expect questions about it during UAT.
17. **This staging project is shared across concurrent sessions/people.** Test data you didn't
    create can appear without warning (§7's Fase 3+4 verification note has a live example). Check
    `created_at` before treating unfamiliar data as a bug in your own work.
18. **`profiles.wms_role_id` and the new permission matrix (§6d) are not read by any RLS policy
    yet.** They're informational/UI-only today — assigning someone "Inbound Supervisor" in
    `/admin` doesn't currently change what they can do anywhere else in the app, only what's
    displayed on the Hak akses tab. Wiring real RLS/UI gating to `wms_role_id` is future work, not
    done this session — don't assume the matrix is enforced anywhere yet.
19. ~~New user accounts cannot be created from `/admin`.~~ **Resolved (§6f, 16 Aug 2026)** — a
    "+ Tambah pengguna baru" form now creates both the Auth account and the `profiles` row via
    the `admin-create-user` edge function, gated to active ADMIN callers. The service role key
    itself still never reaches the client, as required — the edge function is the only thing
    that touches it.
20. **Wave picking (`generate_wave`, in-wave `confirm_pick`) is still unexercised against live
    data** (§6g, 17 Aug 2026) — discrete picking now is, and turned up a real bug in
    `confirm_pick()` itself (§6g #4, fixed) that would have hit wave picking identically since
    they share the same function. Next session: form a wave from BATCH-2608-002 and BATCH-2608-003
    (both still open/`PLANNED` in the staging DB) via `/gelombang`, assign a picker, and work
    through `WavePickSheet` for real — that's the one Fase 3 write path this pass didn't reach.

---

## 9. Next session — do these in order

1. ~~Walk picking and staging end-to-end against live data (gap 2).~~ **Done (§6g, 17 Aug 2026)** —
   9 real bugs found and fixed, including one that made `confirm_pick()` fail on literally every
   call. Batch-close/HPP and forward+backward trace were exercised too.
2. Form a wave across `BATCH-2608-002` and `BATCH-2608-003` (both left `PLANNED`, unpicked, in the
   staging DB for exactly this) via `/gelombang` — `generate_wave` and in-wave `confirm_pick` are
   the one Fase 3 write path §6g didn't reach (gap 0, gap 20). Check each batch lands in its own
   tote and the stop order follows `pick_sequence`. Since discrete `confirm_pick()` had a real bug
   before this session (§6g #4) that would have broken wave picking identically, don't assume
   wave-specific code is clean just because discrete picking now is — the wave-only parts
   (`generate_wave`, tote assignment, `trg_close_wave`) are still genuinely unverified.
3. Import real master data (gap 1) — items, partners, locations with the real Sauce Division rack
   layout, formulas, `ccp_definitions`. Real data will replace the dummy set from §6g; `/admin` →
   Data induk (§6d) can do items/partners/locations via Excel upload instead of hand-written SQL —
   formulas and `ccp_definitions` still need a SQL run, they aren't in the uploadable table list.
4. Exercise the ERP outbox for real (gap 0): close a batch (`trg_enqueue_batch` should fire),
   confirm a row lands in `sync_outbox` against the `ERP-SANDBOX` endpoint seeded in §6g, and
   deploy `erp-sync` (still not deployed) once there's an actual ERP sandbox URL/token to point at.
5. Decide the allergen-zoning rollout approach for real inventory (gap 5) before pointing this at
   actual stock — the hard-block trigger itself is now confirmed working correctly (§6g, scenario 9).
6. Physical label print test — rack labels and handling-unit labels both use the same 50×30mm
   sticker size, unconfirmed against a real printer (gap 4).
7. **Get the Fase 4 go/no-go decision (RAID R41)** before investing anything further in the ERP
   integration. If Neofood adopts a full ERP, most of Fase 4 is wasted work. The code is written;
   deploying and operating it is the expensive part.
8. When ready to leave staging: create a **separate** Supabase project for production and repeat the
   schema + delta runs — don't repoint the same `neotrace-staging` project's placeholder data at
   real operations.
9. Then attack the remaining smaller gaps (6, 7, 8, 9, 10, 16, 17).

---

## 10. Commands

```bash
cd neotrace-web
npm install
npm run dev        # http://localhost:5173
npm run check      # assert-based self-check, no framework
npm run build      # tsc -b && vite build
```

Dev server is registered in the parent `.claude/launch.json` as **`neotrace`**
(`npm --prefix neotrace-web run dev`, port 5173) so `preview_start` can drive it.

---

## 11. Conventions to keep

- UI copy in Bahasa Indonesia; comments in Bahasa Indonesia to match the provided files.
- **Business rules stay in the database.** The frontend translates Postgres exceptions
  (`parseDbError`, `SCAN_MESSAGES`, `ZONE_MESSAGES`) into operator language — it never
  re-implements a rule. Frontend gates (8-char reasons, short-pick detection) mirror the DB
  check so the operator gets told before a round trip; the DB remains the authority.
- Never queue a decision the server must make. `resolve_qr`, `release_lot`, `complete_putaway`,
  and `confirm_pick` are online-only by design. Only recording goes in the outbox.
- Allergen-zoning rejections get a full-screen red panel that must be dismissed — never a toast.
- **No clock in/out buttons.** Labour sessions follow the screen (`useLabourSession`). Asking an
  operator to punch a timer is the fastest way to get productivity data abandoned.
- **Team KPI is the default view; per-person numbers are behind a toggle** and labelled as coaching
  material (RAID R32). Do not build leaderboards.
- **Never touch `idempotency_key` when requeueing a sync message** (RAID R42). It is the only thing
  standing between a retry and a duplicate document in the ERP.
- Forecast output stays hidden for items with fewer than `MIN_PERIODS_FOR_REORDER` periods of
  history (RAID R44) — thin data must not masquerade as a planning number.
- Any deliberate simplification carries a `ponytail:` comment naming the ceiling and upgrade path.
- Status colours go through `pill()` / `lotTone()` in `src/ui.ts`, not ad-hoc hex.
- Accent rules are `borderTop`, never a thick left border (the project design hook flags side-tabs).
- Files stay under 500 lines (project CLAUDE.md).
- **New screens: phone-scanning flows use `s.page`; everything else uses `s.pageWide` (or
  `s.pageForm` for long forms) with card lists wrapped in `s.cardGrid`** (§6e). Don't add a new
  screen with the old bare `s.page` unless it's genuinely another walk-and-scan operator flow
  like Pindai/Put-away/Pick list.

---

## 12. Confidentiality

Client NetSuite/Neofood data stays local. Do not push **real** master data or lot data to a
third-party service, and no cloud-sync plugins on client deliverables.

This session pushed the app's *code and schema* (no real business data — see "Live environment")
to a public GitHub repo and a public Vercel deployment, at the user's explicit request, to get
testable UI access. The Supabase project holding actual data stays access-controlled (RLS, admin
login) regardless of repo visibility. If real Neofood master data gets imported (§9 step 1) while
the repo stays public, re-check that no seed/migration script committed to git ever contains real
supplier names, pricing, or lot data — write it as a one-off SQL run through the Supabase MCP tools
instead of a checked-in file, the same way this session's placeholder data was seeded.
