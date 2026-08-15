# NEOTRACE — Handover

**Project:** NEOTRACE web app — PT Neopangan Selaras Indonesia (Neofood), Sauce Division
**Location:** `D:\Pointstar\OneDrive - 明 and Daughters\Team Lead\Testing AI\neotrace-web`
**Updated:** 15 Aug 2026 · **Status:** Fase 1 + Fase 2 live — backend on a real Supabase project, frontend deployed to Vercel, smoke-tested end-to-end (receive → QC release → auto-issued put-away → completed put-away, allergen zoning trigger active)

Read this top to bottom before touching code. Everything a new session needs is here.

---

## Live environment

| | |
|---|---|
| Supabase project | `neotrace-staging` — ref `wwghhyeidmxcwjfyhtgn`, ap-southeast-1. v1 + Fase 1 delta + Fase 2 delta all applied, `pg_cron` scheduled daily 00:05 WIB. **This is a staging project** — create a separate one before going to real production data. |
| GitHub | [adhi5758-ops/neotrace](https://github.com/adhi5758-ops/neotrace), branch `main`. **Currently public** — contains no real Neofood business data (schema + fictional placeholder seed only), but exposes app architecture and RLS/trigger logic. Consider making it private. |
| Vercel | [neotrace-web.vercel.app](https://neotrace-web.vercel.app) — project `neotrace-web`, auto-deploys on push to `main` via the GitHub integration (connected directly in the Vercel dashboard, not through the Claude↔Vercel MCP connector — that connector can manage projects but its deployment/list APIs return 403/404 unpredictably; don't waste time on it, use `git push`). Deployment protection is off (public). |
| Admin login | `adhi5758@gmail.com`, `profiles.role = 'ADMIN'` |
| Master data | **placeholder only, not real** — 2 suppliers, 1 customer, 3 items (2 raw + 1 finished), 1 formula (2 lines), 2 CCPs, 6 rack locations (A1/A2 × L1/L2, allergen-zoned) + 2 staging areas (from the Fase 2 delta's own seed) |

To ship a code change: commit locally, then run `git push` from this folder — nobody in this environment has git credentials cached, so pushing always needs a human at the keyboard. Vercel rebuilds automatically. To run SQL against the live project, use the Supabase MCP tools with project id `wwghhyeidmxcwjfyhtgn`.

---

## 1. What this is

A React PWA for lot traceability and warehouse execution on the sauce production floor.
Phone-first for operators (receive, scan, put-away, pick, consume, CCP), same pages on desktop
for QA, warehouse supervisors, and finance (QC release, warehouse map, trace, cost).

| | Fase 1 | Fase 2 |
|---|---|---|
| Goal | Actual HPP per batch · two-way traceability · consignment reconciliation | Eliminate misplacement · faster material picking · prevent cross-contamination by system |
| Scope | v1 schema + QR scan + FEFO + QC hold + expiry alerts | Directed put-away · allergen zoning (hard block) · pick list from formula · staging |
| Go-live | 02 Oct 2026 | 04 Dec 2026 (starts 12 Oct, 8 weeks) |

Out of scope (Fase 3+): wave & cluster picking, cross-docking, packing & SSCC, RFID,
dual UoM / catch weight, ERP integration, labour KPI, forecasting.

---

## 2. Source material

All source files now live in this folder alongside the app:

| File | What it is | State |
|---|---|---|
| `neotrace_schema.sql` | v1 core schema — tables, enums, views, `resolve_qr`, `suggest_lots_fefo` | **not yet run anywhere** |
| `neotrace_phase1_delta.sql` | QC hold, FEFO enforcement, expiry alerts, RLS | **not yet run** |
| `neotrace_phase2_delta.sql` | Put-away, allergen zoning, pick lists, staging, console views | **not yet run** |
| `neotrace_schema_v2_wms.sql` | Older full-WMS draft — **do not run**, phase2 delta supersedes it (its own header says so) |
| `NEOTRACE_Fase1_Rencana_Kerja.xlsx` | 6-week plan, T01–T44 | reference |
| `NEOTRACE_Fase2_Rencana_Kerja.xlsx` | 8-week plan, P01–P43, RACI, RAID, exit criteria | reference |
| `neotrace_erd.svg` | ERD, Fase 1 vs Fase 2 marked | reference |

Four modules were supplied as finished code and are used **verbatim** (one edit total, §5):
`src/lib/api.ts`, `src/lib/offlineQueue.ts`, `src/components/QrScanner.tsx`,
`src/components/BatchConsumePanel.tsx`.

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
    components/
      QrScanner.tsx           PROVIDED, untouched
      BatchConsumePanel.tsx   PROVIDED, untouched
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
```

Navigation: bottom tabs are **Beranda · Gudang · QC · Produksi · Telusur**.
Receive/put-away/picking/staging/console all sit under Gudang — five warehouse screens
would not fit in a phone tab bar.

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

---

## 5. The only change made to provided code

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

`App.tsx` reads `isConfigured` and renders a setup screen instead. Everything else in the four
provided files is byte-identical to the originals.

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

---

## 8. Known gaps, in priority order

1. **Master data is placeholder, not real.** Items, suppliers, formula, and rack layout are all
   fictional test data seeded this session — see "Live environment" above. Real PT Neopangan data
   (items, partners, locations, formulas, allergens, `ccp_definitions`, and the Fase 2 location
   attributes: `rack_code`, `level_no`, `position_no`, `max_weight_kg`, `max_hu_count`,
   `allergen_policy`, `pick_sequence`, `is_staging`) still needs importing (T05–T07, P01–P06).
   Also fill `items.weight_per_uom_kg` for every real item or rack capacity checks silently treat
   1 kg per unit.
2. **Picking and staging are untested against live data.** Put-away was walked end-to-end and
   turned up two real bugs (§6a) that static review missed. Picking (`generate_pick_list_from_batch`
   → `confirm_pick`, including a deliberate short pick and a deliberate FEFO override) and staging
   assignment have only been checked for empty-state rendering, not actually exercised. Do this
   before trusting them.
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

---

## 9. Next session — do these in order

1. Import real master data (gap 1) — items, partners, locations with the real Sauce Division rack
   layout, formulas, `ccp_definitions`. This unblocks everything else; right now Receive/Production
   only have three fictional items to pick from.
2. Walk picking and staging end-to-end against live data (gap 2) — generate a pick list from a real
   batch, confirm a pick with a deliberate short pick and a deliberate FEFO override, assign and
   release a staging area. Fix whatever surfaces, the same way put-away's two bugs got fixed this
   session.
3. Continue the golden path past put-away: pick list → record consumption from pick list → CCP →
   close batch → check yield/HPP → trace forward.
4. Decide the allergen-zoning rollout approach for real inventory (gap 5) before pointing this at
   actual stock.
5. Physical label print test — rack labels and handling-unit labels both use the same 50×30mm
   sticker size, unconfirmed against a real printer (gap 4).
6. When ready to leave staging: create a **separate** Supabase project for production and repeat the
   schema + delta runs — don't repoint the same `neotrace-staging` project's placeholder data at
   real operations.
7. Then attack the remaining smaller gaps (6, 7, 8, 9, 10).

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
- Any deliberate simplification carries a `ponytail:` comment naming the ceiling and upgrade path.
- Status colours go through `pill()` / `lotTone()` in `src/ui.ts`, not ad-hoc hex.
- Accent rules are `borderTop`, never a thick left border (the project design hook flags side-tabs).
- Files stay under 500 lines (project CLAUDE.md).

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
