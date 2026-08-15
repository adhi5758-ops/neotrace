-- =====================================================================
-- NEOTRACE v2 — Ekstensi WMS
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- PRASYARAT: jalankan neotrace_schema.sql (v1) terlebih dahulu.
-- File ini menambah kemampuan WMS penuh di atas fondasi lot/HU/QR v1.
--
-- CATATAN EKSEKUSI
--   Bagian 0 berisi ALTER TYPE ... ADD VALUE. PostgreSQL tidak mengizinkan
--   nilai enum baru dipakai pada transaksi yang sama. Jalankan BAGIAN 0
--   sendiri lebih dulu, baru sisanya.
-- =====================================================================

-- =====================================================================
-- BAGIAN 0 — JALANKAN TERPISAH
-- =====================================================================
alter type movement_type add value if not exists 'CROSSDOCK';
alter type movement_type add value if not exists 'PICK';
alter type movement_type add value if not exists 'PACK';
alter type lot_status    add value if not exists 'BLOCKED';
alter type scan_action   add value if not exists 'PUTAWAY';
alter type scan_action   add value if not exists 'PACK';
alter type scan_action   add value if not exists 'LOAD';

-- ==== berhenti di sini, jalankan sisa file sebagai batch kedua ========


-- =====================================================================
-- BAGIAN 1 — LOGISTIK MASUK (Inbound)
-- =====================================================================

create type allergen_policy as enum ('MIXED','ALLERGEN_ONLY','NON_ALLERGEN_ONLY');
create type putaway_strategy as enum ('FIXED','NEAREST_EMPTY','CONSOLIDATE','ZONE_MATCH');

-- 1.1 Lokasi diperkaya: kapasitas, level rak, suhu, zonasi alergen, urutan pick
alter table locations
  add column if not exists rack_code        text,
  add column if not exists level_no         smallint,          -- 1 = paling bawah
  add column if not exists position_no      smallint,
  add column if not exists max_weight_kg    numeric(18,3),
  add column if not exists max_volume_m3    numeric(18,4),
  add column if not exists max_hu_count     smallint,
  add column if not exists temp_min_c       numeric(5,2),
  add column if not exists temp_max_c       numeric(5,2),
  add column if not exists allergen_policy  allergen_policy not null default 'MIXED',
  add column if not exists pick_sequence    integer,           -- urutan jalur pick petugas
  add column if not exists is_receivable    boolean not null default true,
  add column if not exists is_pickable      boolean not null default true,
  add column if not exists is_staging       boolean not null default false;

create index if not exists idx_loc_rack on locations(rack_code, level_no);
create index if not exists idx_loc_pickseq on locations(pick_sequence) where is_pickable;

-- 1.2 Karakteristik penyimpanan per item (untuk rekomendasi put-away)
alter table items
  add column if not exists weight_per_uom_kg numeric(18,4),
  add column if not exists volume_per_uom_m3 numeric(18,6),
  add column if not exists storage_temp_min_c numeric(5,2),
  add column if not exists storage_temp_max_c numeric(5,2),
  add column if not exists preferred_zone_id uuid references locations(id),
  add column if not exists putaway_strategy  putaway_strategy not null default 'ZONE_MATCH',
  add column if not exists is_allergen_carrier boolean not null default false,
  add column if not exists abc_class char(1);                   -- A/B/C untuk cycle count

-- 1.3 Beban lokasi saat ini
create or replace view v_location_load as
select l.id location_id, l.code, l.rack_code, l.level_no, l.allergen_policy,
       l.max_weight_kg, l.max_hu_count,
       coalesce(sum(h.qty_remaining * coalesce(i.weight_per_uom_kg,1)),0) current_weight_kg,
       count(h.id) filter (where h.status='ACTIVE') current_hu_count,
       case when l.max_weight_kg > 0
            then round(coalesce(sum(h.qty_remaining * coalesce(i.weight_per_uom_kg,1)),0)
                       / l.max_weight_kg * 100, 2) end utilisation_pct,
       bool_or(ia.allergen_id is not null) holds_allergen
from locations l
left join handling_units h on h.location_id = l.id and h.status = 'ACTIVE'
left join lots lo on lo.id = h.lot_id
left join items i on i.id = lo.item_id
left join item_allergens ia on ia.item_id = i.id
group by l.id, l.code, l.rack_code, l.level_no, l.allergen_policy, l.max_weight_kg, l.max_hu_count;

-- 1.4 Rekomendasi put-away
--     Aturan kunci: bahan NON-alergen tidak boleh ditaruh DI BAWAH bahan alergen
--     pada rak yang sama (risiko tumpah / kontaminasi silang).
create or replace function suggest_putaway(p_item_id uuid, p_qty numeric, p_uom text default null)
returns table (location_id uuid, location_code text, score numeric, reason text)
language plpgsql stable as $$
declare
  v_item        record;
  v_is_allergen boolean;
  v_weight      numeric;
begin
  select * into v_item from items where id = p_item_id;
  v_is_allergen := exists (select 1 from item_allergens where item_id = p_item_id)
                   or v_item.is_allergen_carrier;
  v_weight := p_qty * coalesce(v_item.weight_per_uom_kg, 1);

  return query
  select l.id, l.code,
         -- skor: makin kecil makin diprioritaskan
         (coalesce(vl.utilisation_pct,0) * 0.5
          + case when l.id = v_item.preferred_zone_id then -50 else 0 end
          + coalesce(l.pick_sequence,999) * 0.01)::numeric,
         concat_ws(' · ',
           case when l.id = v_item.preferred_zone_id then 'zona preferensi' end,
           'utilisasi ' || coalesce(vl.utilisation_pct,0)::text || '%',
           case when v_is_allergen then 'alergen' else 'non-alergen' end)
  from locations l
  left join v_location_load vl on vl.location_id = l.id
  where l.is_active and l.is_receivable and l.type in ('RAW','FINISHED','WIP')
    -- kapasitas berat
    and (l.max_weight_kg is null or coalesce(vl.current_weight_kg,0) + v_weight <= l.max_weight_kg)
    -- kapasitas jumlah HU
    and (l.max_hu_count is null or coalesce(vl.current_hu_count,0) < l.max_hu_count)
    -- suhu
    and (v_item.storage_temp_min_c is null or l.temp_min_c is null or l.temp_min_c >= v_item.storage_temp_min_c)
    and (v_item.storage_temp_max_c is null or l.temp_max_c is null or l.temp_max_c <= v_item.storage_temp_max_c)
    -- kebijakan alergen lokasi
    and (l.allergen_policy = 'MIXED'
         or (v_is_allergen and l.allergen_policy = 'ALLERGEN_ONLY')
         or (not v_is_allergen and l.allergen_policy = 'NON_ALLERGEN_ONLY'))
    -- ATURAN VERTIKAL: non-alergen dilarang di bawah alergen pada rak sama
    and (v_is_allergen or not exists (
          select 1 from v_location_load up
          where up.rack_code = l.rack_code
            and up.level_no > l.level_no
            and up.holds_allergen))
    -- ATURAN VERTIKAL kebalikan: alergen dilarang di atas non-alergen
    and (not v_is_allergen or not exists (
          select 1 from v_location_load dn
          where dn.rack_code = l.rack_code
            and dn.level_no < l.level_no
            and dn.current_hu_count > 0
            and not dn.holds_allergen))
  order by 3
  limit 10;
end;
$$;

-- 1.5 Cross-docking: terima → langsung ke staging kirim, tanpa put-away
alter table goods_receipt_lines
  add column if not exists is_crossdock boolean not null default false,
  add column if not exists crossdock_do_id uuid references delivery_orders(id),
  add column if not exists putaway_location_id uuid references locations(id),
  add column if not exists putaway_at timestamptz,
  add column if not exists putaway_by uuid references profiles(id);

-- 1.6 QC penerimaan: sampling, uji lab, keputusan release
create type qc_test_type as enum ('MICROBIOLOGY','ORGANOLEPTIC','CHEMICAL','PHYSICAL','ALLERGEN','FOREIGN_BODY');
create type sample_type  as enum ('INCOMING','IN_PROCESS','RETAIN','COMPLAINT','STABILITY');

create table qc_samples (
  id             uuid primary key default gen_random_uuid(),
  sample_no      text not null unique,           -- SMP-2608-0031
  type           sample_type not null,
  lot_id         uuid references lots(id),
  batch_id       uuid references production_batches(id),
  hu_id          uuid references handling_units(id),
  qty            numeric(18,3),
  uom            text,
  taken_at       timestamptz not null default now(),
  taken_by       uuid references profiles(id),
  storage_location_id uuid references locations(id),
  retain_until   date,                            -- retain sample: masa edar + margin
  disposed_at    timestamptz,
  disposed_by    uuid references profiles(id),
  remarks        text
);
create index if not exists idx_sample_lot on qc_samples(lot_id);
create index if not exists idx_sample_retain on qc_samples(retain_until) where disposed_at is null;

create table qc_tests (
  id             uuid primary key default gen_random_uuid(),
  sample_id      uuid not null references qc_samples(id) on delete cascade,
  test_type      qc_test_type not null,
  parameter      text not null,                   -- TPC, E.coli, Salmonella, pH, warna, aroma
  method         text,                            -- AOAC / SNI / internal
  spec_min       numeric(18,4),
  spec_max       numeric(18,4),
  spec_text      text,                            -- 'negatif / 25 g'
  result_num     numeric(18,4),
  result_text    text,
  result         qc_result not null default 'PENDING',
  tested_at      timestamptz,
  tested_by      uuid references profiles(id),
  lab_name       text,
  attachment_path text
);
create index if not exists idx_test_sample on qc_tests(sample_id);

-- release lot otomatis hanya bila seluruh uji wajib PASS
create or replace function release_lot(p_lot_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_pending int; v_fail int;
begin
  if not current_role_is('QA','ADMIN') then
    raise exception 'FORBIDDEN: hanya QA yang boleh melepas lot';
  end if;

  select count(*) filter (where t.result='PENDING'),
         count(*) filter (where t.result='FAIL')
    into v_pending, v_fail
  from qc_samples s join qc_tests t on t.sample_id = s.id
  where s.lot_id = p_lot_id and s.type = 'INCOMING';

  if v_fail > 0 then raise exception 'QC_FAILED: ada % uji gagal', v_fail; end if;
  if v_pending > 0 then raise exception 'QC_PENDING: masih ada % uji belum selesai', v_pending; end if;

  update lots set status='RELEASED', remarks = coalesce(p_reason, remarks) where id = p_lot_id;
end;
$$;

-- =====================================================================
-- BAGIAN 2 — STOK & INVENTARIS
-- =====================================================================

-- 2.1 Metode perputaran per item
create type rotation_method as enum ('FEFO','FIFO','LIFO','MANUAL');
alter table items add column if not exists rotation_method rotation_method not null default 'FEFO';

-- 2.2 Dual UoM / catch weight — drum vs kilogram riil
alter table items
  add column if not exists is_catch_weight boolean not null default false,
  add column if not exists secondary_uom   text;                -- DRUM, SAK, JERIKEN

alter table handling_units
  add column if not exists qty_secondary       numeric(18,3),   -- mis. 10 drum
  add column if not exists uom_secondary       text,
  add column if not exists tare_weight_kg      numeric(18,3),
  add column if not exists gross_weight_kg     numeric(18,3),
  add column if not exists rfid_epc            text unique,
  add column if not exists serial_no           text;

-- 2.3 Pemilihan lot generik: FEFO / FIFO / LIFO
create or replace function suggest_lots(p_item_id uuid, p_qty numeric,
                                        p_method rotation_method default null)
returns table (
  lot_id uuid, lot_code text, hu_id uuid, hu_code text,
  qty_available numeric, expiry_date date, received_at timestamptz,
  location_code text, pick_sequence integer, suggested_qty numeric
) language plpgsql stable as $$
declare v_method rotation_method;
begin
  select coalesce(p_method, rotation_method) into v_method from items where id = p_item_id;

  return query
  with avail as (
    select l.id, l.lot_code, h.id hu, h.hu_code, h.qty_remaining, l.expiry_date, l.received_at,
           lc.code loc, lc.pick_sequence,
           sum(h.qty_remaining) over (
             order by
               case when v_method='FEFO' then l.expiry_date end asc nulls last,
               case when v_method='FIFO' then l.received_at end asc,
               case when v_method='LIFO' then l.received_at end desc,
               lc.pick_sequence nulls last, h.hu_code
             rows between unbounded preceding and current row) running
    from lots l
    join handling_units h on h.lot_id = l.id and h.status='ACTIVE' and h.qty_remaining > 0
    left join locations lc on lc.id = h.location_id
    where l.item_id = p_item_id
      and l.status = 'RELEASED'
      and (l.expiry_date is null or l.expiry_date >= current_date)
      and (l.halal_valid_until is null or l.halal_valid_until >= current_date)
      and coalesce(lc.is_pickable, true)
  )
  select a.id, a.lot_code, a.hu, a.hu_code, a.qty_remaining, a.expiry_date, a.received_at,
         a.loc, a.pick_sequence,
         least(a.qty_remaining, p_qty - (a.running - a.qty_remaining))
  from avail a
  where a.running - a.qty_remaining < p_qty
  order by a.running;
end;
$$;

-- 2.4 Penegakan FEFO saat pick: menolak lot yang lebih baru bila ada yang lebih dekat expiry
create or replace function assert_fefo(p_item_id uuid, p_lot_id uuid)
returns void language plpgsql stable as $$
declare v_exp date; v_earlier text;
begin
  select expiry_date into v_exp from lots where id = p_lot_id;
  select string_agg(lot_code, ', ') into v_earlier
  from lots l
  where l.item_id = p_item_id and l.status='RELEASED' and l.id <> p_lot_id
    and l.expiry_date < v_exp
    and exists (select 1 from handling_units h
                where h.lot_id = l.id and h.status='ACTIVE' and h.qty_remaining > 0);
  if v_earlier is not null then
    raise exception 'FEFO_VIOLATION: masih ada lot lebih dekat kedaluwarsa (%)', v_earlier;
  end if;
end;
$$;

-- 2.5 Stock opname berkala (cycle count) tanpa menghentikan operasi
create type count_type as enum ('FULL','CYCLE','SPOT','ABC');
alter table stock_counts
  add column if not exists count_type count_type not null default 'FULL',
  add column if not exists abc_class char(1),
  add column if not exists is_blind boolean not null default true,   -- qty sistem disembunyikan
  add column if not exists freeze_location boolean not null default false;

alter table stock_count_lines
  add column if not exists counted_at timestamptz,
  add column if not exists counted_by uuid references profiles(id),
  add column if not exists recount_qty numeric(18,3),
  add column if not exists is_approved boolean not null default false;

-- 2.6 Aturan peringatan & notifikasi (30/60/90 hari, stok kritis)
create type alert_type as enum ('EXPIRY','HALAL_EXPIRY','LOW_STOCK','QC_PENDING','RETAIN_DUE','CAPACITY','FEFO_OVERRIDE');
create type alert_channel as enum ('IN_APP','EMAIL','WHATSAPP','WEBHOOK');

create table alert_rules (
  id             uuid primary key default gen_random_uuid(),
  type           alert_type not null,
  item_id        uuid references items(id),        -- null = semua item
  threshold_days smallint[],                       -- '{90,60,30}'
  threshold_qty  numeric(18,3),
  channels       alert_channel[] not null default '{IN_APP}',
  recipient_roles user_role[] not null default '{WAREHOUSE,QA}',
  is_active      boolean not null default true
);

create table notifications (
  id           bigserial primary key,
  type         alert_type not null,
  severity     text not null default 'INFO',      -- INFO / WARN / CRITICAL
  title        text not null,
  body         text,
  lot_id       uuid references lots(id),
  item_id      uuid references items(id),
  batch_id     uuid references production_batches(id),
  location_id  uuid references locations(id),
  target_role  user_role,
  target_user  uuid references profiles(id),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  acted_at     timestamptz,
  acted_by     uuid references profiles(id)
);
create index if not exists idx_notif_open on notifications(target_role, created_at desc) where read_at is null;

-- 2.7 Karantina otomatis barang kedaluwarsa (jalankan via pg_cron tiap hari 00:05 WIB)
create or replace function run_daily_expiry_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_blocked int := 0; v_notif int := 0;
begin
  -- blokir lot kedaluwarsa / halal habis
  with upd as (
    update lots set status = 'BLOCKED'
    where status = 'RELEASED'
      and (expiry_date < current_date or halal_valid_until < current_date)
    returning 1
  ) select count(*) into v_blocked from upd;

  -- notifikasi ambang 90/60/30 hari
  with ins as (
    insert into notifications(type, severity, title, body, lot_id, item_id, target_role)
    select 'EXPIRY',
           case when l.expiry_date - current_date <= 30 then 'CRITICAL' else 'WARN' end,
           'Lot ' || l.lot_code || ' mendekati kedaluwarsa',
           i.name || ' · sisa ' || (l.expiry_date - current_date) || ' hari · '
             || coalesce(sum(h.qty_remaining),0) || ' ' || i.base_uom,
           l.id, i.id, 'WAREHOUSE'
    from lots l
    join items i on i.id = l.item_id
    join handling_units h on h.lot_id = l.id and h.status='ACTIVE' and h.qty_remaining > 0
    where l.status = 'RELEASED'
      and (l.expiry_date - current_date) in (90, 60, 30, 14, 7)
    group by l.id, l.lot_code, l.expiry_date, i.id, i.name, i.base_uom
    returning 1
  ) select count(*) into v_notif from ins;

  return jsonb_build_object('blocked', v_blocked, 'notifications', v_notif, 'ran_at', now());
end;
$$;
-- select cron.schedule('neotrace-daily','5 17 * * *', $$select run_daily_expiry_jobs()$$);  -- 00:05 WIB

-- =====================================================================
-- BAGIAN 3 — LOGISTIK KELUAR (Outbound)
-- =====================================================================

create type pick_status as enum ('OPEN','ASSIGNED','IN_PROGRESS','SHORT','COMPLETED','CANCELLED');
create type pick_strategy as enum ('DISCRETE','BATCH','ZONE','WAVE','CLUSTER');

-- 3.1 Gelombang pick: gabungkan beberapa order/batch dalam satu perjalanan
create table pick_waves (
  id           uuid primary key default gen_random_uuid(),
  wave_no      text not null unique,
  strategy     pick_strategy not null default 'DISCRETE',
  planned_for  timestamptz,
  status       pick_status not null default 'OPEN',
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);

create table pick_lists (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,              -- PCK-2608-0117
  wave_id       uuid references pick_waves(id),
  source_type   text not null,                     -- 'BATCH' (ke produksi) / 'DO' (ke klien)
  batch_id      uuid references production_batches(id),
  do_id         uuid references delivery_orders(id),
  zone_id       uuid references locations(id),
  assigned_to   uuid references profiles(id),
  status        pick_status not null default 'OPEN',
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint chk_pick_source check (
    (source_type='BATCH' and batch_id is not null) or
    (source_type='DO' and do_id is not null))
);

create table pick_list_lines (
  id             uuid primary key default gen_random_uuid(),
  pick_list_id   uuid not null references pick_lists(id) on delete cascade,
  sequence       integer not null,                 -- urutan jalur terpendek
  item_id        uuid not null references items(id),
  suggested_lot_id uuid references lots(id),
  suggested_hu_id  uuid references handling_units(id),
  from_location_id uuid references locations(id),
  qty_requested  numeric(18,4) not null,
  qty_picked     numeric(18,4),
  picked_lot_id  uuid references lots(id),
  picked_hu_id   uuid references handling_units(id),
  uom            text not null,
  status         pick_status not null default 'OPEN',
  short_reason   text,
  fefo_override  boolean not null default false,
  override_reason text,
  picked_at      timestamptz,
  picked_by      uuid references profiles(id),
  scan_event_id  bigint references scan_events(id),
  constraint chk_pick_override check (not fefo_override or override_reason is not null)
);
create index if not exists idx_pll_list on pick_list_lines(pick_list_id, sequence);

-- 3.2 Kitted picking dari formula: terbitkan picking list proporsional untuk satu batch
create or replace function generate_pick_list_from_batch(p_batch_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_pick uuid; v_batch record; v_ratio numeric; v_seq int := 0; r record; s record;
begin
  select pb.*, f.output_qty into v_batch
  from production_batches pb join formulas f on f.id = pb.formula_id
  where pb.id = p_batch_id;
  if not found then raise exception 'BATCH_OR_FORMULA_NOT_FOUND'; end if;

  v_ratio := v_batch.target_qty / v_batch.output_qty;

  insert into pick_lists(doc_no, source_type, batch_id, status, created_at)
  values (next_doc_no('PCK'), 'BATCH', p_batch_id, 'OPEN', now())
  returning id into v_pick;

  for r in
    select fl.item_id, fl.uom, fl.qty * v_ratio * (1 + fl.scrap_pct/100) qty_needed
    from formula_lines fl where fl.formula_id = v_batch.formula_id order by fl.sequence
  loop
    for s in select * from suggest_lots(r.item_id, r.qty_needed) loop
      v_seq := v_seq + 10;
      insert into pick_list_lines(pick_list_id, sequence, item_id, suggested_lot_id,
        suggested_hu_id, from_location_id, qty_requested, uom)
      select v_pick, v_seq, r.item_id, s.lot_id, s.hu_id,
             (select id from locations where code = s.location_code), s.suggested_qty, r.uom;
    end loop;
  end loop;

  -- urutkan ulang mengikuti jalur pick gudang
  with ord as (
    select pll.id, row_number() over (order by coalesce(l.pick_sequence, 9999), l.code) * 10 rn
    from pick_list_lines pll left join locations l on l.id = pll.from_location_id
    where pll.pick_list_id = v_pick
  )
  update pick_list_lines p set sequence = ord.rn from ord where ord.id = p.id;

  return v_pick;
end;
$$;

-- 3.3 Staging: antrean bahan per lini masak agar tidak tertukar
create table staging_assignments (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references locations(id),
  batch_id      uuid references production_batches(id),
  do_id         uuid references delivery_orders(id),
  line_code     text,
  assigned_at   timestamptz not null default now(),
  released_at   timestamptz,
  assigned_by   uuid references profiles(id)
);
-- satu lokasi staging hanya boleh dipakai satu batch pada satu waktu
create unique index if not exists idx_staging_exclusive
  on staging_assignments(location_id) where released_at is null;

-- 3.4 Packing & dokumen pengiriman
create table packages (
  id            uuid primary key default gen_random_uuid(),
  package_no    text not null unique,              -- PKG-2608-00981
  qr_token      uuid not null unique default gen_random_uuid(),
  do_id         uuid references delivery_orders(id),
  package_type  text,                              -- KARTON, PALLET, SHRINK
  gross_weight_kg numeric(18,3),
  net_weight_kg   numeric(18,3),
  dimensions_cm   text,
  parent_package_id uuid references packages(id),
  sscc          text,                              -- GS1 SSCC bila dipakai
  packed_at     timestamptz,
  packed_by     uuid references profiles(id)
);

create table package_contents (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references packages(id) on delete cascade,
  lot_id      uuid not null references lots(id),
  hu_id       uuid references handling_units(id),
  item_id     uuid not null references items(id),
  qty         numeric(18,3) not null,
  uom         text not null
);

alter table delivery_orders
  add column if not exists carrier_awb text,
  add column if not exists packing_list_path text,
  add column if not exists label_path text,
  add column if not exists planned_ship_date date,
  add column if not exists loaded_at timestamptz,
  add column if not exists loaded_by uuid references profiles(id);

-- =====================================================================
-- BAGIAN 4 — INTEGRASI TEKNOLOGI
-- =====================================================================

-- 4.1 Barcode & RFID: satu item/HU bisa punya banyak kode
create type barcode_type as enum ('EAN13','GTIN14','CODE128','QR','GS1_128','RFID_EPC','INTERNAL');

create table barcodes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  type        barcode_type not null,
  item_id     uuid references items(id),
  hu_id       uuid references handling_units(id),
  package_id  uuid references packages(id),
  uom         text,                                -- barcode karton vs barcode pouch
  qty_per_code numeric(18,3),
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (code, type),
  constraint chk_barcode_target check (num_nonnulls(item_id, hu_id, package_id) = 1)
);
create index if not exists idx_barcode_code on barcodes(code);

-- resolusi universal: satu fungsi untuk QR HU, barcode item, EPC RFID, no. paket
create or replace function resolve_code(p_code text, p_action scan_action default 'LOOKUP',
                                        p_location_id uuid default null, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; v_uuid uuid;
begin
  -- 1. coba sebagai token QR handling unit
  begin v_uuid := p_code::uuid; exception when others then v_uuid := null; end;
  if v_uuid is not null then
    v := resolve_qr(v_uuid, p_action, p_location_id, p_device);
    if (v->>'ok')::boolean or (v->>'error') <> 'NOT_FOUND' then return v; end if;
  end if;

  -- 2. coba sebagai hu_code
  select resolve_qr(qr_token, p_action, p_location_id, p_device) into v
  from handling_units where hu_code = p_code;
  if v is not null then return v; end if;

  -- 3. coba sebagai barcode / RFID
  select to_jsonb(x) into v from (
    select b.type, b.code, i.id item_id, i.code item_code, i.name item_name,
           b.uom, b.qty_per_code, h.id hu_id, pk.id package_id
    from barcodes b
    left join items i on i.id = b.item_id
    left join handling_units h on h.id = b.hu_id
    left join packages pk on pk.id = b.package_id
    where b.code = p_code
  ) x;

  insert into scan_events(qr_token, hu_id, action, location_id, scanned_by, device_id, success, error_code, remarks)
  values (null, (v->>'hu_id')::uuid, p_action, p_location_id, auth.uid(), p_device,
          v is not null, case when v is null then 'NOT_FOUND' end, p_code);

  return coalesce(v, '{}'::jsonb) || jsonb_build_object('ok', v is not null,
                                                        'error', case when v is null then 'NOT_FOUND' end);
end;
$$;

-- 4.2 Integrasi sistem eksternal (ERP/NetSuite, e-commerce, kurir) — pola outbox
create type sync_direction as enum ('OUTBOUND','INBOUND');
create type sync_status    as enum ('PENDING','SENT','ACKED','FAILED','SKIPPED');

create table integration_endpoints (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,               -- NETSUITE_PROD, SHIPPER_API
  name         text not null,
  base_url     text,
  direction    sync_direction not null,
  entity_types text[] not null,                    -- {'GRN','DO','BATCH','ITEM'}
  is_active    boolean not null default true,
  config       jsonb not null default '{}'
);

create table sync_outbox (
  id            bigserial primary key,
  endpoint_id   uuid references integration_endpoints(id),
  entity_type   text not null,                     -- GRN, DO, BATCH, ADJUSTMENT
  entity_id     uuid not null,
  operation     text not null,                     -- CREATE, UPDATE, CANCEL
  payload       jsonb not null,
  status        sync_status not null default 'PENDING',
  attempts      smallint not null default 0,
  last_error    text,
  external_id   text,                              -- ID dokumen di sistem tujuan
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  acked_at      timestamptz
);
create index if not exists idx_outbox_pending on sync_outbox(status, created_at) where status in ('PENDING','FAILED');

-- 4.3 Perangkat & sesi kerja lapangan
create table devices (
  id            uuid primary key default gen_random_uuid(),
  device_id     text not null unique,
  label         text,
  type          text,                              -- HANDHELD, PHONE, TABLET, RFID_GATE
  assigned_zone_id uuid references locations(id),
  last_seen_at  timestamptz,
  app_version   text,
  is_active     boolean not null default true
);

-- =====================================================================
-- BAGIAN 5 — ANALITIK & SUMBER DAYA
-- =====================================================================

-- 5.1 Manajemen tenaga kerja
create type task_type as enum ('RECEIVE','PUTAWAY','PICK','PACK','LOAD','COUNT','TRANSFER','PRODUCTION','CLEANING');

create table labour_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id),
  task_type     task_type not null,
  reference_id  uuid,                              -- pick_list_id, batch_id, count_id
  zone_id       uuid references locations(id),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  units_handled numeric(18,3),
  lines_handled integer,
  device_id     text,
  duration_min  numeric(10,2) generated always as (
    case when ended_at is not null
         then round(extract(epoch from (ended_at - started_at))/60.0, 2) end) stored
);
create index if not exists idx_labour_user on labour_sessions(user_id, started_at desc);

create or replace view v_labour_kpi as
select ls.user_id, p.full_name, ls.task_type,
       date_trunc('day', ls.started_at) day,
       count(*) sessions,
       sum(ls.duration_min) total_min,
       sum(ls.lines_handled) total_lines,
       round(sum(ls.lines_handled)::numeric / nullif(sum(ls.duration_min),0) * 60, 2) lines_per_hour,
       round(sum(ls.units_handled) / nullif(sum(ls.duration_min),0) * 60, 2) units_per_hour
from labour_sessions ls join profiles p on p.id = ls.user_id
group by 1,2,3,4;

-- akurasi pick & kepatuhan FEFO per petugas
create or replace view v_pick_accuracy as
select pll.picked_by, p.full_name,
       count(*) lines_picked,
       count(*) filter (where pll.status='SHORT') lines_short,
       count(*) filter (where pll.fefo_override) fefo_overrides,
       count(*) filter (where pll.picked_lot_id is distinct from pll.suggested_lot_id) lot_deviations,
       round(count(*) filter (where pll.picked_lot_id = pll.suggested_lot_id)::numeric
             / nullif(count(*),0) * 100, 2) accuracy_pct
from pick_list_lines pll left join profiles p on p.id = pll.picked_by
where pll.status in ('COMPLETED','SHORT')
group by 1,2;

-- 5.2 Peramalan kebutuhan stok (hasil model disimpan, model dijalankan di luar DB)
create table demand_forecasts (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references items(id),
  period_start  date not null,
  period_end    date not null,
  forecast_qty  numeric(18,3) not null,
  actual_qty    numeric(18,3),
  method        text not null,                     -- MOVING_AVG, HOLT_WINTERS, MANUAL
  confidence_low  numeric(18,3),
  confidence_high numeric(18,3),
  generated_at  timestamptz not null default now(),
  generated_by  uuid references profiles(id),
  unique (item_id, period_start, period_end, method)
);

-- konsumsi historis sebagai input peramalan
create or replace view v_consumption_history as
select bc.item_id, date_trunc('month', bc.consumed_at) period,
       sum(bc.qty_actual) qty_consumed, count(distinct bc.batch_id) batch_count
from batch_consumption bc group by 1,2;

-- 5.3 Dasbor: perputaran & utilisasi
create or replace view v_inventory_turnover as
with issued as (
  select i.id item_id, i.name, i.code,
         sum(abs(m.qty)) qty_issued,
         sum(abs(m.qty) * coalesce(m.unit_cost,0)) cogs
  from stock_movements m join items i on i.id = m.item_id
  where m.type in ('ISSUE','SHIPMENT') and m.moved_at >= now() - interval '365 days'
  group by 1,2,3
), onhand as (
  select lo.item_id, sum(h.qty_remaining) qty_on_hand,
         sum(h.qty_remaining * coalesce(lo.unit_cost,0)) value_on_hand
  from handling_units h join lots lo on lo.id = h.lot_id
  where h.status='ACTIVE' group by 1
)
select i.code, i.name, coalesce(s.qty_issued,0) qty_issued_12m,
       coalesce(o.qty_on_hand,0) qty_on_hand, coalesce(o.value_on_hand,0) value_on_hand,
       round(coalesce(s.cogs,0) / nullif(o.value_on_hand,0), 2) turnover_ratio,
       round(365 * nullif(o.value_on_hand,0) / nullif(s.cogs,0), 1) days_on_hand
from items i left join issued s on s.item_id = i.id left join onhand o on o.item_id = i.id
where i.is_active;

create or replace view v_warehouse_utilisation as
select l.type, count(*) location_count,
       round(avg(vl.utilisation_pct), 2) avg_utilisation_pct,
       count(*) filter (where vl.utilisation_pct >= 90) near_full,
       count(*) filter (where coalesce(vl.current_hu_count,0) = 0) empty_locations
from locations l left join v_location_load vl on vl.location_id = l.id
where l.is_active group by l.type;

-- dock-to-stock: waktu dari terima sampai masuk rak (KPI inbound standar)
create or replace view v_dock_to_stock as
select gr.doc_no, gr.received_at, grl.putaway_at,
       round(extract(epoch from (grl.putaway_at - gr.received_at))/3600.0, 2) hours_to_stock,
       p.name supplier_name, i.name item_name
from goods_receipt_lines grl
join goods_receipts gr on gr.id = grl.receipt_id
join items i on i.id = grl.item_id
join partners p on p.id = gr.supplier_id
where grl.putaway_at is not null;

-- =====================================================================
-- BAGIAN 6 — RLS UNTUK TABEL BARU
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'qc_samples','qc_tests','alert_rules','notifications','pick_waves','pick_lists',
    'pick_list_lines','staging_assignments','packages','package_contents','barcodes',
    'integration_endpoints','sync_outbox','devices','labour_sessions','demand_forecasts'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy p_read_%1$s on %1$I for select to authenticated using (
         exists (select 1 from profiles where id = auth.uid() and is_active))', t);
  end loop;
end $$;

create policy p_qa_samples on qc_samples for all to authenticated
  using (current_role_is('QA','ADMIN')) with check (current_role_is('QA','ADMIN'));
create policy p_qa_tests on qc_tests for all to authenticated
  using (current_role_is('QA','ADMIN')) with check (current_role_is('QA','ADMIN'));
create policy p_wh_pick on pick_lists for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_pick_l on pick_list_lines for all to authenticated
  using (current_role_is('WAREHOUSE','OPERATOR','ADMIN')) with check (current_role_is('WAREHOUSE','OPERATOR','ADMIN'));
create policy p_wh_pack on packages for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_staging on staging_assignments for all to authenticated
  using (current_role_is('WAREHOUSE','OPERATOR','ADMIN')) with check (current_role_is('WAREHOUSE','OPERATOR','ADMIN'));
create policy p_labour_self on labour_sessions for insert to authenticated
  with check (user_id = auth.uid());
create policy p_notif_ack on notifications for update to authenticated
  using (target_user = auth.uid() or current_role_is('ADMIN'));
create policy p_admin_integration on integration_endpoints for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));

alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table pick_list_lines;
