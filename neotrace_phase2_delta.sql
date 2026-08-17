-- =====================================================================
-- NEOTRACE — FASE 2 (delta di atas v1 + Fase 1)
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- CAKUPAN FASE 2
--   1. Put-away terarah      : rekomendasi lokasi + tugas put-away + dock-to-stock
--   2. Zonasi alergen        : kebijakan per lokasi + BLOKIR KERAS penempatan salah
--   3. Pick list dari formula: kitted picking proporsional per batch, urut jalur
--   4. Staging               : antrean bahan per lini masak, satu lokasi satu batch
--
-- TIDAK TERMASUK (Fase 3+): wave & cluster picking, cross-docking, packing &
--   SSCC, barcode/RFID selain QR, dual UoM/catch weight, integrasi ERP,
--   KPI tenaga kerja, forecasting.
--
-- PRASYARAT: neotrace_schema.sql (v1) + neotrace_phase1_delta.sql.
-- JANGAN jalankan neotrace_schema_v2_wms.sql — file ini menggantikannya
-- untuk cakupan Fase 2.
-- =====================================================================

-- =====================================================================
-- BAGIAN 0 — JALANKAN SENDIRI DULU
-- =====================================================================
alter type movement_type add value if not exists 'PICK';
alter type scan_action   add value if not exists 'PUTAWAY';

-- ==== berhenti di sini, jalankan sisa file sebagai batch kedua ========


-- =====================================================================
-- BAGIAN 1 — MASTER LOKASI & KARAKTERISTIK PENYIMPANAN
-- =====================================================================
create type allergen_policy  as enum ('MIXED','ALLERGEN_ONLY','NON_ALLERGEN_ONLY');
create type putaway_status   as enum ('OPEN','ASSIGNED','DONE','CANCELLED');
create type pick_status      as enum ('OPEN','ASSIGNED','IN_PROGRESS','SHORT','COMPLETED','CANCELLED');

alter table locations
  add column if not exists rack_code       text,
  add column if not exists level_no        smallint,          -- 1 = paling bawah
  add column if not exists position_no     smallint,
  add column if not exists max_weight_kg   numeric(18,3),
  add column if not exists max_hu_count    smallint,
  add column if not exists temp_min_c      numeric(5,2),
  add column if not exists temp_max_c      numeric(5,2),
  add column if not exists allergen_policy allergen_policy not null default 'MIXED',
  add column if not exists pick_sequence   integer,           -- urutan jalur pick
  add column if not exists is_receivable   boolean not null default true,
  add column if not exists is_pickable     boolean not null default true,
  add column if not exists is_staging      boolean not null default false;

create index if not exists idx_loc_rack    on locations(rack_code, level_no);
create index if not exists idx_loc_pickseq on locations(pick_sequence) where is_pickable;

alter table items
  add column if not exists weight_per_uom_kg   numeric(18,4),
  add column if not exists storage_temp_min_c  numeric(5,2),
  add column if not exists storage_temp_max_c  numeric(5,2),
  add column if not exists preferred_zone_id   uuid references locations(id),
  add column if not exists is_allergen_carrier boolean not null default false,
  add column if not exists abc_class           char(1);

-- apakah satu item membawa alergen (dari master atau flag manual)
create or replace function item_is_allergen(p_item_id uuid)
returns boolean language sql stable as $$
  select coalesce(bool_or(true) filter (where ia.allergen_id is not null), false)
         or coalesce(max(case when i.is_allergen_carrier then 1 else 0 end), 0) = 1
  from items i left join item_allergens ia on ia.item_id = i.id
  where i.id = p_item_id;
$$;

-- beban & isi tiap lokasi saat ini
create or replace view v_location_load as
select l.id location_id, l.code, l.rack_code, l.level_no, l.allergen_policy,
       l.max_weight_kg, l.max_hu_count, l.temp_min_c, l.temp_max_c,
       coalesce(sum(h.qty_remaining * coalesce(i.weight_per_uom_kg, 1)), 0) current_weight_kg,
       count(h.id) filter (where h.status = 'ACTIVE') current_hu_count,
       case when l.max_weight_kg > 0
            then round(coalesce(sum(h.qty_remaining * coalesce(i.weight_per_uom_kg,1)),0)
                       / l.max_weight_kg * 100, 2) end utilisation_pct,
       coalesce(bool_or(item_is_allergen(i.id)), false) holds_allergen
from locations l
left join handling_units h on h.location_id = l.id and h.status = 'ACTIVE'
left join lots lo on lo.id = h.lot_id
left join items i on i.id = lo.item_id
group by l.id, l.code, l.rack_code, l.level_no, l.allergen_policy,
         l.max_weight_kg, l.max_hu_count, l.temp_min_c, l.temp_max_c;

-- =====================================================================
-- BAGIAN 2 — ZONASI ALERGEN: BLOKIR KERAS
--   Fase 1 hanya menyarankan. Di Fase 2 penempatan salah DITOLAK database,
--   karena kontaminasi silang bukan sesuatu yang boleh lolos lewat bypass API.
-- =====================================================================
create or replace function assert_allergen_zoning(p_item_id uuid, p_location_id uuid, p_hu_id uuid)
returns void language plpgsql stable as $$
declare
  v_alg   boolean;
  v_loc   record;
  v_conflict text;
begin
  if p_location_id is null then return; end if;
  select * into v_loc from locations where id = p_location_id;
  if not found then raise exception 'LOCATION_NOT_FOUND'; end if;

  v_alg := item_is_allergen(p_item_id);

  -- 2a. kebijakan lokasi
  if v_loc.allergen_policy = 'ALLERGEN_ONLY' and not v_alg then
    raise exception 'ZONE_POLICY: lokasi % khusus bahan alergen', v_loc.code;
  end if;
  if v_loc.allergen_policy = 'NON_ALLERGEN_ONLY' and v_alg then
    raise exception 'ZONE_POLICY: lokasi % khusus bahan non-alergen', v_loc.code;
  end if;

  -- 2b. aturan vertikal: non-alergen dilarang DI BAWAH alergen pada rak sama
  if not v_alg and v_loc.rack_code is not null then
    select string_agg(up.code, ', ') into v_conflict
    from v_location_load up
    where up.rack_code = v_loc.rack_code
      and up.level_no > v_loc.level_no
      and up.holds_allergen;
    if v_conflict is not null then
      raise exception 'ALLERGEN_ABOVE: bahan alergen tersimpan di atas (%). Pilih rak lain.', v_conflict;
    end if;
  end if;

  -- 2c. kebalikannya: alergen dilarang DI ATAS non-alergen pada rak sama
  if v_alg and v_loc.rack_code is not null then
    select string_agg(dn.code, ', ') into v_conflict
    from v_location_load dn
    where dn.rack_code = v_loc.rack_code
      and dn.level_no < v_loc.level_no
      and dn.current_hu_count > 0
      and not dn.holds_allergen
      and (p_hu_id is null or not exists (
            select 1 from handling_units h where h.id = p_hu_id and h.location_id = dn.location_id));
    if v_conflict is not null then
      raise exception 'NON_ALLERGEN_BELOW: bahan non-alergen tersimpan di bawah (%). Pilih rak alergen.', v_conflict;
    end if;
  end if;
end;
$$;

create or replace function trg_hu_location_guard() returns trigger
language plpgsql as $$
declare v_item uuid;
begin
  if new.location_id is distinct from coalesce(old.location_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and new.status = 'ACTIVE' then
    select lo.item_id into v_item from lots lo where lo.id = new.lot_id;
    perform assert_allergen_zoning(v_item, new.location_id, new.id);
  end if;
  return new;
end;
$$;
create trigger t_hu_location_guard
  before insert or update of location_id on handling_units
  for each row execute function trg_hu_location_guard();

-- =====================================================================
-- BAGIAN 3 — REKOMENDASI & TUGAS PUT-AWAY
-- =====================================================================

-- v1 chk_qty_nonzero menolak qty=0 di stock_movements. Put-away murni
-- (pindah lokasi, jumlah tidak berubah) SEHARUSNYA qty=0 — trg_apply_movement_to_hu
-- dari v1 menerapkan qty sebagai delta ke qty_remaining, jadi qty bukan-nol di sini
-- akan menggandakan qty_remaining. Longgarkan constraint-nya, bukan qty-nya.
alter table stock_movements drop constraint chk_qty_nonzero;
alter table stock_movements add constraint chk_qty_nonzero check (qty <> 0 or type = 'TRANSFER');

create or replace function suggest_putaway(p_item_id uuid, p_qty numeric)
returns table (location_id uuid, location_code text, score numeric, reason text)
language plpgsql stable as $$
declare v_item record; v_alg boolean; v_weight numeric;
begin
  select * into v_item from items where id = p_item_id;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  v_alg := item_is_allergen(p_item_id);
  v_weight := p_qty * coalesce(v_item.weight_per_uom_kg, 1);

  return query
  select l.id, l.code,
         -- skor rendah = prioritas tinggi
         (coalesce(vl.utilisation_pct, 0) * 0.5
          + case when l.id = v_item.preferred_zone_id then -60 else 0 end
          + case when vl.current_hu_count > 0 and vl.holds_allergen = v_alg then -15 else 0 end
          + coalesce(l.pick_sequence, 9999) * 0.01)::numeric,
         concat_ws(' · ',
           case when l.id = v_item.preferred_zone_id then 'zona preferensi' end,
           case when vl.current_hu_count > 0 then 'konsolidasi' end,
           'utilisasi ' || coalesce(vl.utilisation_pct, 0)::text || '%',
           case when v_alg then 'alergen' else 'non-alergen' end)
  from locations l
  left join v_location_load vl on vl.location_id = l.id
  where l.is_active and l.is_receivable and not l.is_staging
    and l.type in ('RAW','FINISHED','WIP')
    and (l.max_weight_kg is null or coalesce(vl.current_weight_kg,0) + v_weight <= l.max_weight_kg)
    and (l.max_hu_count is null or coalesce(vl.current_hu_count,0) < l.max_hu_count)
    and (v_item.storage_temp_min_c is null or l.temp_min_c is null or l.temp_min_c >= v_item.storage_temp_min_c)
    and (v_item.storage_temp_max_c is null or l.temp_max_c is null or l.temp_max_c <= v_item.storage_temp_max_c)
    -- lokasi yang akan ditolak trigger zonasi disaring lebih awal
    and (l.allergen_policy = 'MIXED'
         or (v_alg and l.allergen_policy = 'ALLERGEN_ONLY')
         or (not v_alg and l.allergen_policy = 'NON_ALLERGEN_ONLY'))
    and (v_alg or l.rack_code is null or not exists (
          select 1 from v_location_load up
          where up.rack_code = l.rack_code and up.level_no > l.level_no and up.holds_allergen))
    and (not v_alg or l.rack_code is null or not exists (
          select 1 from v_location_load dn
          where dn.rack_code = l.rack_code and dn.level_no < l.level_no
            and dn.current_hu_count > 0 and not dn.holds_allergen))
  order by 3
  limit 8;
end;
$$;

create table putaway_tasks (
  id                   uuid primary key default gen_random_uuid(),
  doc_no               text not null unique,             -- PTA-2610-0042
  hu_id                uuid not null references handling_units(id),
  receipt_id           uuid references goods_receipts(id),
  suggested_location_id uuid references locations(id),
  actual_location_id   uuid references locations(id),
  status               putaway_status not null default 'OPEN',
  assigned_to          uuid references profiles(id),
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  completed_by         uuid references profiles(id),
  deviation_reason     text,
  scan_event_id        bigint references scan_events(id),
  constraint chk_putaway_deviation check (
    status <> 'DONE'
    or actual_location_id = suggested_location_id
    or deviation_reason is not null)
);
create index if not exists idx_putaway_open on putaway_tasks(status) where status in ('OPEN','ASSIGNED');
create unique index if not exists idx_putaway_hu_open on putaway_tasks(hu_id) where status in ('OPEN','ASSIGNED');

-- terbitkan tugas put-away untuk seluruh kemasan satu lot yang baru lolos QC
create or replace function create_putaway_tasks(p_lot_id uuid, p_receipt_id uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_item uuid; r record; v_loc uuid; v_n int := 0;
begin
  select item_id into v_item from lots where id = p_lot_id;
  if v_item is null then raise exception 'LOT_NOT_FOUND'; end if;

  for r in
    select h.id, h.qty_remaining from handling_units h
    where h.lot_id = p_lot_id and h.status = 'ACTIVE'
      and not exists (select 1 from putaway_tasks t
                      where t.hu_id = h.id and t.status in ('OPEN','ASSIGNED'))
  loop
    select location_id into v_loc from suggest_putaway(v_item, r.qty_remaining) limit 1;
    insert into putaway_tasks(doc_no, hu_id, receipt_id, suggested_location_id)
    values (next_doc_no('PTA'), r.id, p_receipt_id, v_loc);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- selesaikan put-away: pindahkan HU, catat pergerakan, kunci aturan zonasi
create or replace function complete_putaway(
  p_task_id uuid, p_actual_location_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t record; v_item uuid; v_lot uuid; v_qty numeric; v_uom text; v_from uuid;
begin
  select * into t from putaway_tasks where id = p_task_id;
  if not found then raise exception 'TASK_NOT_FOUND'; end if;
  if t.status = 'DONE' then raise exception 'TASK_ALREADY_DONE'; end if;

  select h.lot_id, h.qty_remaining, h.uom, h.location_id, lo.item_id
    into v_lot, v_qty, v_uom, v_from, v_item
  from handling_units h join lots lo on lo.id = h.lot_id where h.id = t.hu_id;

  if p_actual_location_id is distinct from t.suggested_location_id
     and (p_reason is null or length(trim(p_reason)) < 8) then
    raise exception 'REASON_REQUIRED: lokasi berbeda dari saran, alasan wajib diisi';
  end if;

  -- trigger zonasi akan menolak bila penempatan melanggar aturan alergen
  update handling_units set location_id = p_actual_location_id where id = t.hu_id;

  insert into stock_movements(type, item_id, lot_id, hu_id, qty, uom,
                              from_location_id, to_location_id, doc_type, doc_id, doc_no)
  values ('TRANSFER', v_item, v_lot, t.hu_id, 0, v_uom,
          v_from, p_actual_location_id, 'PUTAWAY', t.id, t.doc_no);

  update putaway_tasks
     set status = 'DONE', actual_location_id = p_actual_location_id,
         deviation_reason = p_reason, completed_at = now(), completed_by = auth.uid()
   where id = p_task_id;
end;
$$;

-- terbitkan tugas put-away otomatis begitu lot dilepas QA
create or replace function trg_putaway_on_release() returns trigger
language plpgsql as $$
begin
  if new.status = 'RELEASED' and old.status = 'QUARANTINE' then
    perform create_putaway_tasks(new.id);
  end if;
  return new;
end;
$$;
create trigger t_putaway_on_release after update of status on lots
  for each row execute function trg_putaway_on_release();

-- =====================================================================
-- BAGIAN 4 — PICK LIST DARI FORMULA (kitted picking)
-- =====================================================================
create table pick_lists (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,                -- PCK-2610-0117
  source_type   text not null,                       -- 'BATCH' | 'DO'
  batch_id      uuid references production_batches(id),
  do_id         uuid references delivery_orders(id),
  staging_location_id uuid references locations(id),
  assigned_to   uuid references profiles(id),
  status        pick_status not null default 'OPEN',
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid references profiles(id),
  constraint chk_pick_source check (
    (source_type = 'BATCH' and batch_id is not null and do_id is null) or
    (source_type = 'DO'    and do_id    is not null and batch_id is null))
);
create index if not exists idx_pick_open on pick_lists(status) where status <> 'COMPLETED';

create table pick_list_lines (
  id               uuid primary key default gen_random_uuid(),
  pick_list_id     uuid not null references pick_lists(id) on delete cascade,
  sequence         integer not null,                 -- urutan jalur terpendek
  item_id          uuid not null references items(id),
  suggested_lot_id uuid references lots(id),
  suggested_hu_id  uuid references handling_units(id),
  from_location_id uuid references locations(id),
  qty_requested    numeric(18,4) not null check (qty_requested > 0),
  qty_picked       numeric(18,4),
  picked_lot_id    uuid references lots(id),
  picked_hu_id     uuid references handling_units(id),
  uom              text not null,
  status           pick_status not null default 'OPEN',
  short_reason     text,
  fefo_override    boolean not null default false,
  override_reason  text,
  picked_at        timestamptz,
  picked_by        uuid references profiles(id),
  scan_event_id    bigint references scan_events(id),
  constraint chk_pll_override check (not fefo_override or override_reason is not null),
  constraint chk_pll_short    check (status <> 'SHORT' or short_reason is not null)
);
create index if not exists idx_pll_list on pick_list_lines(pick_list_id, sequence);

-- terbitkan picking list proporsional dari formula, diurutkan mengikuti jalur gudang
create or replace function generate_pick_list_from_batch(p_batch_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_pick uuid; v_batch record; v_ratio numeric; r record; s record;
begin
  select pb.id, pb.target_qty, pb.formula_id, f.output_qty
    into v_batch
  from production_batches pb
  join formulas f on f.id = pb.formula_id
  where pb.id = p_batch_id;
  if not found then raise exception 'BATCH_OR_FORMULA_NOT_FOUND'; end if;
  if v_batch.output_qty is null or v_batch.output_qty = 0 then
    raise exception 'FORMULA_OUTPUT_ZERO';
  end if;

  if exists (select 1 from pick_lists where batch_id = p_batch_id and status <> 'CANCELLED') then
    raise exception 'PICK_LIST_EXISTS: batch ini sudah punya picking list aktif';
  end if;

  v_ratio := v_batch.target_qty / v_batch.output_qty;

  insert into pick_lists(doc_no, source_type, batch_id, created_by)
  values (next_doc_no('PCK'), 'BATCH', p_batch_id, auth.uid())
  returning id into v_pick;

  for r in
    select fl.item_id, fl.uom,
           round(fl.qty * v_ratio * (1 + fl.scrap_pct/100), 4) qty_needed
    from formula_lines fl
    where fl.formula_id = v_batch.formula_id
    order by fl.sequence
  loop
    for s in select * from suggest_lots_fefo(r.item_id, r.qty_needed) loop
      insert into pick_list_lines(pick_list_id, sequence, item_id, suggested_lot_id,
                                  suggested_hu_id, from_location_id, qty_requested, uom)
      values (v_pick, 0, r.item_id, s.lot_id, s.hu_id,
              (select id from locations where code = s.location_code),
              s.suggested_qty, r.uom);
    end loop;
  end loop;

  if not exists (select 1 from pick_list_lines where pick_list_id = v_pick) then
    delete from pick_lists where id = v_pick;
    raise exception 'NO_STOCK: tidak ada lot siap pakai untuk formula batch ini';
  end if;

  -- urutkan mengikuti jalur pick gudang
  with ord as (
    select pll.id, (row_number() over (order by coalesce(l.pick_sequence, 9999), l.code, pll.id)) * 10 rn
    from pick_list_lines pll
    left join locations l on l.id = pll.from_location_id
    where pll.pick_list_id = v_pick
  )
  update pick_list_lines p set sequence = ord.rn from ord where ord.id = p.id;

  return v_pick;
end;
$$;

-- konfirmasi satu baris pick lewat scan QR
create or replace function confirm_pick(
  p_line_id uuid, p_hu_id uuid, p_qty numeric,
  p_override_reason text default null, p_scan_event_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare l record; v_lot uuid; v_item uuid; v_loc uuid; v_override boolean := false;
begin
  select * into l from pick_list_lines where id = p_line_id;
  if not found then raise exception 'PICK_LINE_NOT_FOUND'; end if;
  if l.status = 'COMPLETED' then raise exception 'PICK_LINE_DONE'; end if;

  select h.lot_id, h.location_id, lo.item_id into v_lot, v_loc, v_item
  from handling_units h join lots lo on lo.id = h.lot_id where h.id = p_hu_id;
  if v_lot is null then raise exception 'HU_NOT_FOUND'; end if;
  if v_item <> l.item_id then raise exception 'WRONG_ITEM: kemasan ini bukan bahan yang diminta'; end if;

  perform assert_lot_usable(v_lot);

  if p_hu_id is distinct from l.suggested_hu_id then
    v_override := true;
    if p_override_reason is null or length(trim(p_override_reason)) < 8 then
      -- masih boleh bila lot sama, hanya beda kemasan
      if v_lot is distinct from l.suggested_lot_id then
        perform assert_fefo(l.item_id, v_lot);   -- akan raise bila melanggar FEFO
        raise exception 'REASON_REQUIRED: lot berbeda dari saran, alasan wajib diisi';
      end if;
      v_override := false;
    end if;
  end if;

  update pick_list_lines
     set qty_picked = p_qty, picked_lot_id = v_lot, picked_hu_id = p_hu_id,
         -- ::pick_status wajib — CASE dengan dua cabang literal teks polos
         -- di-resolve Postgres sebagai text SEBELUM melihat tipe kolom
         -- tujuan, jadi assignment langsung gagal tanpa cast eksplisit ini
         -- (ditemukan live 17 Aug 2026, picking belum pernah benar-benar
         -- dicoba end-to-end sebelum sesi ini)
         status = case when p_qty >= qty_requested then 'COMPLETED' else 'SHORT' end::pick_status,
         short_reason = case when p_qty < qty_requested
                             then coalesce(p_override_reason, 'kurang dari permintaan') end,
         fefo_override = v_override, override_reason = p_override_reason,
         picked_at = now(), picked_by = auth.uid(), scan_event_id = p_scan_event_id
   where id = p_line_id;

  insert into stock_movements(type, item_id, lot_id, hu_id, qty, uom,
                              from_location_id, doc_type, doc_id, scan_event_id)
  values ('PICK', l.item_id, v_lot, p_hu_id, -abs(p_qty), l.uom,
          v_loc, 'PICK', l.pick_list_id, p_scan_event_id);

  update pick_lists set
    status = case when not exists (
                    select 1 from pick_list_lines
                    where pick_list_id = l.pick_list_id and status in ('OPEN','ASSIGNED','IN_PROGRESS'))
                  then 'COMPLETED' else 'IN_PROGRESS' end::pick_status,
    completed_at = case when not exists (
                    select 1 from pick_list_lines
                    where pick_list_id = l.pick_list_id and status in ('OPEN','ASSIGNED','IN_PROGRESS'))
                  then now() end
  where id = l.pick_list_id;
end;
$$;

-- =====================================================================
-- BAGIAN 5 — STAGING
--   Satu lokasi staging hanya boleh dipakai satu batch pada satu waktu,
--   supaya bahan antar lini masak tidak tertukar.
-- =====================================================================
create table staging_assignments (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references locations(id),
  batch_id     uuid references production_batches(id),
  do_id        uuid references delivery_orders(id),
  line_code    text,
  assigned_at  timestamptz not null default now(),
  assigned_by  uuid references profiles(id),
  released_at  timestamptz,
  released_by  uuid references profiles(id),
  constraint chk_staging_source check (num_nonnulls(batch_id, do_id) = 1)
);
create unique index if not exists idx_staging_exclusive
  on staging_assignments(location_id) where released_at is null;
create unique index if not exists idx_staging_batch_open
  on staging_assignments(batch_id) where released_at is null and batch_id is not null;

create or replace function assign_staging(p_location_id uuid, p_batch_id uuid, p_line_code text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_is_staging boolean;
begin
  select is_staging into v_is_staging from locations where id = p_location_id;
  if not coalesce(v_is_staging, false) then
    raise exception 'NOT_A_STAGING_LOCATION';
  end if;
  insert into staging_assignments(location_id, batch_id, line_code, assigned_by)
  values (p_location_id, p_batch_id, p_line_code, auth.uid())
  returning id into v_id;
  update pick_lists set staging_location_id = p_location_id
   where batch_id = p_batch_id and status <> 'CANCELLED';
  return v_id;
exception
  when unique_violation then
    raise exception 'STAGING_OCCUPIED: lokasi atau batch ini sudah punya staging aktif';
end;
$$;

create or replace function release_staging(p_assignment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update staging_assignments
     set released_at = now(), released_by = auth.uid()
   where id = p_assignment_id and released_at is null;
end;
$$;

-- =====================================================================
-- BAGIAN 6 — VIEW OPERASIONAL
-- =====================================================================

-- dock-to-stock: jam dari terima sampai masuk rak
create or replace view v_dock_to_stock as
select gr.doc_no receipt_no, gr.received_at, t.completed_at putaway_at,
       round(extract(epoch from (t.completed_at - gr.received_at))/3600.0, 2) hours_to_stock,
       p.name supplier_name, i.name item_name, l.code location_code,
       (t.actual_location_id is distinct from t.suggested_location_id) deviated
from putaway_tasks t
join handling_units h on h.id = t.hu_id
join lots lo on lo.id = h.lot_id
join items i on i.id = lo.item_id
left join goods_receipts gr on gr.id = t.receipt_id
left join partners p on p.id = gr.supplier_id
left join locations l on l.id = t.actual_location_id
where t.status = 'DONE' and gr.received_at is not null;

-- kepatuhan put-away terhadap saran sistem
create or replace view v_putaway_compliance as
select date_trunc('week', t.completed_at) week,
       count(*) tasks_done,
       count(*) filter (where t.actual_location_id is distinct from t.suggested_location_id) deviations,
       round(100 - count(*) filter (where t.actual_location_id is distinct from t.suggested_location_id)::numeric
             / nullif(count(*),0) * 100, 2) compliance_pct
from putaway_tasks t where t.status = 'DONE'
group by 1 order by 1 desc;

-- kinerja picking
create or replace view v_pick_performance as
select pl.id pick_list_id, pl.doc_no, pb.batch_no, i.name product_name,
       count(pll.id) total_lines,
       count(pll.id) filter (where pll.status = 'COMPLETED') lines_done,
       count(pll.id) filter (where pll.status = 'SHORT') lines_short,
       count(pll.id) filter (where pll.fefo_override) fefo_overrides,
       round(extract(epoch from (pl.completed_at - pl.started_at))/60.0, 1) minutes_taken,
       pr.full_name picker
from pick_lists pl
left join pick_list_lines pll on pll.pick_list_id = pl.id
left join production_batches pb on pb.id = pl.batch_id
left join items i on i.id = pb.item_id
left join profiles pr on pr.id = pl.assigned_to
group by pl.id, pl.doc_no, pb.batch_no, i.name, pl.completed_at, pl.started_at, pr.full_name;

-- papan staging: apa yang sedang menempati tiap area
create or replace view v_staging_board as
select l.code location_code, l.name location_name, sa.line_code,
       pb.batch_no, i.name product_name, sa.assigned_at,
       round(extract(epoch from (now() - sa.assigned_at))/3600.0, 1) hours_occupied,
       pl.doc_no pick_list_no, pl.status pick_status
from locations l
left join staging_assignments sa on sa.location_id = l.id and sa.released_at is null
left join production_batches pb on pb.id = sa.batch_id
left join items i on i.id = pb.item_id
left join pick_lists pl on pl.batch_id = sa.batch_id and pl.status <> 'CANCELLED'
where l.is_staging and l.is_active;

-- peta okupansi gudang untuk konsol desktop
create or replace view v_warehouse_map as
select l.rack_code, l.level_no, l.position_no, l.code, l.type, l.allergen_policy,
       vl.current_hu_count, vl.utilisation_pct, vl.holds_allergen,
       (select string_agg(distinct i.name, ', ')
        from handling_units h join lots lo on lo.id = h.lot_id join items i on i.id = lo.item_id
        where h.location_id = l.id and h.status = 'ACTIVE') contents
from locations l
left join v_location_load vl on vl.location_id = l.id
where l.is_active and l.rack_code is not null
order by l.rack_code, l.level_no, l.position_no;

-- =====================================================================
-- BAGIAN 7 — RLS
-- =====================================================================
alter table putaway_tasks        enable row level security;
alter table pick_lists           enable row level security;
alter table pick_list_lines      enable row level security;
alter table staging_assignments  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['putaway_tasks','pick_lists','pick_list_lines','staging_assignments'] loop
    execute format(
      'create policy p_read_%1$s on %1$I for select to authenticated using (
         exists (select 1 from profiles where id = auth.uid() and is_active))', t);
  end loop;
end $$;

create policy p_wh_putaway on putaway_tasks for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_pick on pick_lists for all to authenticated
  using (current_role_is('WAREHOUSE','PLANNER','ADMIN')) with check (current_role_is('WAREHOUSE','PLANNER','ADMIN'));
create policy p_wh_pick_lines on pick_list_lines for all to authenticated
  using (current_role_is('WAREHOUSE','OPERATOR','ADMIN')) with check (current_role_is('WAREHOUSE','OPERATOR','ADMIN'));
create policy p_wh_staging on staging_assignments for all to authenticated
  using (current_role_is('WAREHOUSE','OPERATOR','ADMIN')) with check (current_role_is('WAREHOUSE','OPERATOR','ADMIN'));

alter publication supabase_realtime add table putaway_tasks;
alter publication supabase_realtime add table pick_list_lines;

-- =====================================================================
-- BAGIAN 8 — SEED
-- =====================================================================
insert into number_sequences(prefix, period, last_number, padding) values
 ('PTA', to_char(now(),'YYMM'), 0, 4),
 ('PCK', to_char(now(),'YYMM'), 0, 4)
on conflict do nothing;

-- contoh zonasi rak. Sesuaikan dengan denah gudang Sauce Division sebenarnya.
insert into locations(code, name, type, rack_code, level_no, position_no,
                      max_weight_kg, max_hu_count, allergen_policy, pick_sequence, is_staging)
values
 ('A1-L1-01','Rak A1 Level 1 Pos 1','RAW','A1',1,1,1200,8,'NON_ALLERGEN_ONLY',10,false),
 ('A1-L2-01','Rak A1 Level 2 Pos 1','RAW','A1',2,1,1000,8,'NON_ALLERGEN_ONLY',20,false),
 ('A2-L1-01','Rak A2 Level 1 Pos 1','RAW','A2',1,1,1200,8,'ALLERGEN_ONLY',30,false),
 ('A2-L2-01','Rak A2 Level 2 Pos 1','RAW','A2',2,1,1000,8,'ALLERGEN_ONLY',40,false),
 ('STG-L1','Staging Line Saus 1','STAGING',null,null,null,null,null,'MIXED',null,true),
 ('STG-L2','Staging Line Saus 2','STAGING',null,null,null,null,null,'MIXED',null,true)
on conflict (code) do nothing;

comment on function assert_allergen_zoning is
  'Aturan zonasi alergen. Ambang dan denah rak wajib dikonfirmasi ke tim QA/Food Safety Neofood sebelum dikunci di produksi.';
