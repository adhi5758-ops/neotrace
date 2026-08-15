-- =====================================================================
-- NEOTRACE — Batch & Lot Traceability
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division, Tangerang
-- Target: Supabase / PostgreSQL 15+
--
-- Konsep kunci
--   lot              = kumpulan bahan/produk dengan satu asal & satu expiry
--   handling_unit    = SATU kemasan fisik (drum/sak/karton/palet) = SATU QR
--   stock_movement   = buku besar pergerakan; append-only, tidak pernah di-UPDATE
--   scan_event       = jejak setiap pemindaian QR (untuk monitoring operasional)
--
-- Urutan eksekusi: file ini idempotent-ish, jalankan sekali di SQL Editor.
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";

-- =====================================================================
-- 0. ENUM
-- =====================================================================
create type item_type        as enum ('RAW','PACKAGING','WIP','FINISHED','CONSUMABLE');
create type owner_type       as enum ('OWN','CONSIGNED');          -- milik Neofood / titipan klien
create type lot_status       as enum ('QUARANTINE','RELEASED','HOLD','REJECTED','CONSUMED','EXPIRED');
create type hu_status        as enum ('ACTIVE','EMPTY','SHIPPED','SCRAPPED','MERGED');
create type location_type    as enum ('RAW','WIP','FINISHED','QUARANTINE','REJECT','STAGING','PRODUCTION','VIRTUAL');
create type partner_type     as enum ('SUPPLIER','CUSTOMER','BOTH','TRANSPORTER');
create type movement_type    as enum (
  'RECEIPT',          -- masuk dari supplier
  'PRODUCTION_IN',    -- hasil produksi masuk gudang
  'ISSUE',            -- keluar ke produksi
  'RETURN_TO_STORE',  -- sisa bahan dikembalikan dari produksi
  'TRANSFER',         -- pindah lokasi
  'SHIPMENT',         -- kirim ke klien
  'CUSTOMER_RETURN',  -- retur dari klien
  'ADJUSTMENT',       -- penyesuaian stock opname
  'SCRAP'             -- pemusnahan
);
create type batch_status     as enum ('PLANNED','RUNNING','QC_HOLD','CLOSED','CANCELLED');
create type qc_result        as enum ('PASS','FAIL','PENDING');
create type scan_action      as enum ('LOOKUP','RECEIVE','ISSUE','TRANSFER','PICK','COUNT','SHIP','VERIFY','SCRAP');
create type doc_status       as enum ('DRAFT','POSTED','CANCELLED');
create type user_role        as enum ('OPERATOR','WAREHOUSE','QA','PLANNER','FINANCE','ADMIN','VIEWER');

-- =====================================================================
-- 1. PENGGUNA & ROLE
-- =====================================================================
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null,
  employee_no   text unique,
  role          user_role not null default 'VIEWER',
  department    text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- helper dipakai di seluruh policy RLS
create or replace function current_role_is(variadic roles user_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and is_active and role = any(roles)
  );
$$;

-- =====================================================================
-- 2. MASTER DATA
-- =====================================================================
create table locations (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,             -- GBB-01, WIP-L2, FG-A3
  name          text not null,
  type          location_type not null,
  parent_id     uuid references locations(id),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table partners (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  type               partner_type not null,
  npwp               text,
  address            text,
  contact_name       text,
  contact_phone      text,
  halal_cert_no      text,                        -- untuk supplier bahan
  halal_valid_until  date,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);

create table allergens (
  id      smallint primary key,
  code    text not null unique,                   -- SOY, WHEAT, CRUSTACEAN, MILK, EGG, FISH, PEANUT, TREENUT, SULPHITE
  name_id text not null,
  name_en text not null
);

create table items (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,        -- RM-CBM-001, FG-SBS-1KG
  name               text not null,
  type               item_type not null,
  base_uom           text not null default 'KG',  -- KG, L, PCS
  shelf_life_days    integer,                     -- untuk hitung expiry produk jadi
  standard_cost      numeric(18,4),               -- HPP standar / base_uom
  min_stock          numeric(18,3),
  requires_coa       boolean not null default false,
  requires_halal_cert boolean not null default true,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table item_allergens (
  item_id     uuid references items(id) on delete cascade,
  allergen_id smallint references allergens(id),
  primary key (item_id, allergen_id)
);

-- konversi satuan, mis. 1 DRUM = 200 KG untuk item tertentu
create table item_uom_conversions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id) on delete cascade,
  uom         text not null,
  factor      numeric(18,6) not null check (factor > 0),  -- 1 uom = factor * base_uom
  unique (item_id, uom)
);

-- ---------------------------------------------------------------- formula
create table formulas (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references items(id),      -- produk jadi
  version       integer not null default 1,
  output_qty    numeric(18,3) not null,                  -- basis, mis. 100 KG
  std_yield_pct numeric(6,3) not null default 98.000,
  is_active     boolean not null default true,
  effective_from date not null default current_date,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (item_id, version)
);

create table formula_lines (
  id          uuid primary key default gen_random_uuid(),
  formula_id  uuid not null references formulas(id) on delete cascade,
  item_id     uuid not null references items(id),
  qty         numeric(18,4) not null check (qty > 0),
  uom         text not null,
  scrap_pct   numeric(6,3) not null default 0,
  sequence    smallint not null default 10
);

-- ------------------------------------------------------------ CCP / HACCP
create table ccp_definitions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid references items(id),          -- null = berlaku untuk semua SKU
  code        text not null,                      -- CCP-1, CCP-2, CCP-3, MUTU-BRIX
  name        text not null,
  parameter   text not null,                      -- pH, Suhu, Metal detector, Brix
  uom         text,
  min_value   numeric(18,4),
  max_value   numeric(18,4),
  is_critical boolean not null default true,      -- true = CCP, false = parameter mutu
  is_active   boolean not null default true,
  unique (item_id, code)
);

-- =====================================================================
-- 3. LOT — inti traceability
-- =====================================================================
create table lots (
  id                  uuid primary key default gen_random_uuid(),
  lot_code            text not null unique,       -- LOT-2608-0147 (di-generate)
  item_id             uuid not null references items(id),
  supplier_lot_no     text,                       -- no. lot dari supplier
  supplier_id         uuid references partners(id),
  production_batch_id uuid,                       -- diisi bila lot ini hasil produksi (FK di bawah)

  received_at         timestamptz,
  manufactured_on     date,
  expiry_date         date,

  -- kepemilikan: WAJIB, jangan ditaruh di kolom keterangan
  owner_type          owner_type not null default 'OWN',
  owner_partner_id    uuid references partners(id),

  -- kepatuhan
  halal_cert_no       text,
  halal_valid_until   date,
  coa_received        boolean not null default false,
  coa_file_path       text,                       -- Supabase Storage

  unit_cost           numeric(18,4),              -- biaya per base_uom, sumber HPP
  qty_received        numeric(18,3) not null default 0,
  status              lot_status not null default 'QUARANTINE',
  status_changed_at   timestamptz,
  status_changed_by   uuid references profiles(id),
  remarks             text,
  created_at          timestamptz not null default now(),
  created_by          uuid references profiles(id),

  constraint chk_consigned_owner
    check (owner_type = 'OWN' or owner_partner_id is not null)
);
create index idx_lots_item      on lots(item_id);
create index idx_lots_expiry    on lots(expiry_date) where status = 'RELEASED';
create index idx_lots_owner     on lots(owner_partner_id) where owner_type = 'CONSIGNED';
create index idx_lots_halal     on lots(halal_valid_until);

-- alergen aktual per lot (kadang beda dari master, mis. ganti supplier)
create table lot_allergens (
  lot_id      uuid references lots(id) on delete cascade,
  allergen_id smallint references allergens(id),
  primary key (lot_id, allergen_id)
);

-- riwayat perubahan status lot: QUARANTINE -> RELEASED -> HOLD, dst.
create table lot_status_history (
  id          bigserial primary key,
  lot_id      uuid not null references lots(id) on delete cascade,
  from_status lot_status,
  to_status   lot_status not null,
  reason      text,
  changed_by  uuid references profiles(id),
  changed_at  timestamptz not null default now()
);

-- =====================================================================
-- 4. HANDLING UNIT — satu kemasan fisik = satu QR
-- =====================================================================
create table handling_units (
  id             uuid primary key default gen_random_uuid(),
  hu_code        text not null unique,            -- NF-HU-2608-000147, dicetak di label
  qr_token       uuid not null unique default gen_random_uuid(),  -- isi QR, tidak bisa ditebak
  lot_id         uuid not null references lots(id),
  package_type   text,                            -- DRUM, SAK, JERIKEN, KARTON, PALLET
  qty_initial    numeric(18,3) not null check (qty_initial > 0),
  qty_remaining  numeric(18,3) not null,
  uom            text not null,
  location_id    uuid references locations(id),
  status         hu_status not null default 'ACTIVE',
  parent_hu_id   uuid references handling_units(id),   -- palet berisi karton
  label_printed_at timestamptz,
  label_print_count smallint not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid references profiles(id),
  constraint chk_hu_remaining check (qty_remaining >= 0 and qty_remaining <= qty_initial)
);
create index idx_hu_lot      on handling_units(lot_id);
create index idx_hu_location on handling_units(location_id) where status = 'ACTIVE';
create index idx_hu_token    on handling_units(qr_token);

-- audit pencetakan label (reprint label adalah risiko: dua QR untuk satu fisik)
create table label_prints (
  id           bigserial primary key,
  hu_id        uuid not null references handling_units(id) on delete cascade,
  printed_by   uuid references profiles(id),
  printed_at   timestamptz not null default now(),
  reason       text,                              -- 'INITIAL', 'REPRINT - label rusak'
  printer_name text
);

-- =====================================================================
-- 5. DOKUMEN GUDANG
-- =====================================================================
create table goods_receipts (                    -- GRN / penerimaan bahan
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,        -- GRN-2608-0031
  supplier_id       uuid not null references partners(id),
  po_no             text,
  supplier_do_no    text,                        -- no. surat jalan supplier
  received_at       timestamptz not null default now(),
  vehicle_no        text,
  driver_name       text,
  temperature_c     numeric(5,2),                -- suhu saat terima
  packaging_ok      boolean,
  organoleptic_ok   boolean,
  status            doc_status not null default 'DRAFT',
  received_by       uuid references profiles(id),
  attachment_path   text,                        -- foto surat jalan / CoA
  remarks           text,
  created_at        timestamptz not null default now()
);

create table goods_receipt_lines (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid not null references goods_receipts(id) on delete cascade,
  item_id       uuid not null references items(id),
  lot_id        uuid references lots(id),
  qty_document  numeric(18,3) not null,           -- qty di surat jalan
  qty_received  numeric(18,3) not null,           -- qty aktual timbang
  qty_variance  numeric(18,3) generated always as (qty_received - qty_document) stored,
  uom           text not null,
  unit_price    numeric(18,4),
  hu_count      smallint,                         -- berapa kemasan → berapa QR dicetak
  remarks       text
);

create table delivery_orders (                    -- pengiriman ke klien
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,           -- DO-2608-4498
  customer_id     uuid not null references partners(id),
  so_no           text,
  shipped_at      timestamptz,
  ship_to_address text,
  transporter_id  uuid references partners(id),
  vehicle_no      text,
  driver_name     text,
  temperature_c   numeric(5,2),
  status          doc_status not null default 'DRAFT',
  shipped_by      uuid references profiles(id),
  pod_path        text,                           -- proof of delivery
  remarks         text,
  created_at      timestamptz not null default now()
);

create table delivery_order_lines (
  id          uuid primary key default gen_random_uuid(),
  do_id       uuid not null references delivery_orders(id) on delete cascade,
  item_id     uuid not null references items(id),
  lot_id      uuid not null references lots(id),  -- WAJIB: menjawab "produk saya dari batch mana"
  hu_id       uuid references handling_units(id),
  qty         numeric(18,3) not null check (qty > 0),
  uom         text not null,
  unit_price  numeric(18,4)
);

create table stock_counts (                       -- stock opname
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  location_id   uuid references locations(id),
  counted_on    date not null default current_date,
  status        doc_status not null default 'DRAFT',
  counted_by    uuid references profiles(id),
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  remarks       text
);

create table stock_count_lines (
  id            uuid primary key default gen_random_uuid(),
  count_id      uuid not null references stock_counts(id) on delete cascade,
  hu_id         uuid references handling_units(id),
  lot_id        uuid not null references lots(id),
  qty_system    numeric(18,3) not null,
  qty_physical  numeric(18,3) not null,
  qty_variance  numeric(18,3) generated always as (qty_physical - qty_system) stored,
  reason        text
);

-- =====================================================================
-- 6. PRODUKSI
-- =====================================================================
create table production_batches (
  id              uuid primary key default gen_random_uuid(),
  batch_no        text not null unique,           -- BTC-2608-031
  item_id         uuid not null references items(id),
  formula_id      uuid references formulas(id),
  customer_id     uuid references partners(id),   -- untuk siapa batch ini dibuat
  line_code       text,                           -- Line Saus 2
  target_qty      numeric(18,3) not null,
  actual_qty      numeric(18,3),
  reject_qty      numeric(18,3) default 0,
  output_lot_id   uuid references lots(id),       -- lot produk jadi yang dihasilkan
  started_at      timestamptz,
  closed_at       timestamptz,
  status          batch_status not null default 'PLANNED',
  qc_result       qc_result not null default 'PENDING',
  qc_by           uuid references profiles(id),
  qc_at           timestamptz,
  operator_id     uuid references profiles(id),
  remarks         text,
  created_at      timestamptz not null default now(),

  yield_pct numeric(8,4) generated always as (
    case when target_qty > 0 and actual_qty is not null
         then round(actual_qty / target_qty * 100, 4) end
  ) stored
);
alter table lots
  add constraint fk_lots_production_batch
  foreign key (production_batch_id) references production_batches(id);

create table batch_consumption (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references production_batches(id) on delete cascade,
  lot_id          uuid not null references lots(id),
  hu_id           uuid references handling_units(id),
  item_id         uuid not null references items(id),
  qty_planned     numeric(18,4),
  qty_actual      numeric(18,4) not null check (qty_actual >= 0),
  uom             text not null,
  unit_cost       numeric(18,4),                  -- snapshot biaya saat dipakai
  line_cost       numeric(18,4) generated always as (qty_actual * coalesce(unit_cost,0)) stored,
  fefo_override   boolean not null default false, -- operator ambil lot bukan saran sistem
  override_reason text,
  consumed_at     timestamptz not null default now(),
  consumed_by     uuid references profiles(id),
  constraint chk_override_reason
    check (not fefo_override or override_reason is not null)
);
create index idx_bc_batch on batch_consumption(batch_id);
create index idx_bc_lot   on batch_consumption(lot_id);   -- kunci telusur mundur

create table ccp_readings (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references production_batches(id) on delete cascade,
  ccp_id       uuid not null references ccp_definitions(id),
  value_num    numeric(18,4),
  value_text   text,                              -- untuk CCP boolean seperti metal detector
  result       qc_result not null default 'PENDING',
  corrective_action text,                         -- wajib bila FAIL (ISO 22000)
  recorded_at  timestamptz not null default now(),
  recorded_by  uuid references profiles(id),
  constraint chk_ccp_fail_action
    check (result <> 'FAIL' or corrective_action is not null)
);
create index idx_ccp_batch on ccp_readings(batch_id);

-- biaya tambahan per batch (tenaga kerja, overhead, utilitas)
create table batch_costs (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references production_batches(id) on delete cascade,
  cost_type   text not null,                      -- LABOUR, OVERHEAD, UTILITY, PACKAGING_SVC
  amount      numeric(18,4) not null,
  remarks     text
);

-- =====================================================================
-- 7. BUKU BESAR PERGERAKAN — append only
-- =====================================================================
create table stock_movements (
  id              bigserial primary key,
  moved_at        timestamptz not null default now(),
  type            movement_type not null,
  item_id         uuid not null references items(id),
  lot_id          uuid not null references lots(id),
  hu_id           uuid references handling_units(id),
  qty             numeric(18,3) not null,          -- + masuk, − keluar
  uom             text not null,
  from_location_id uuid references locations(id),
  to_location_id   uuid references locations(id),

  -- referensi dokumen sumber
  doc_type        text,                            -- GRN, DO, BATCH, COUNT, TRANSFER, SCRAP
  doc_id          uuid,
  doc_no          text,

  unit_cost       numeric(18,4),
  performed_by    uuid references profiles(id),
  scan_event_id   bigint,                          -- diisi bila berasal dari scan QR
  remarks         text,
  constraint chk_qty_nonzero check (qty <> 0)
);
create index idx_mv_lot      on stock_movements(lot_id);
create index idx_mv_hu       on stock_movements(hu_id);
create index idx_mv_item_time on stock_movements(item_id, moved_at desc);
create index idx_mv_doc      on stock_movements(doc_type, doc_id);

-- =====================================================================
-- 8. SCAN QR — jejak operasional & monitoring
-- =====================================================================
create table scan_events (
  id            bigserial primary key,
  scanned_at    timestamptz not null default now(),
  qr_token      uuid,                              -- apa adanya, walau tidak ketemu
  hu_id         uuid references handling_units(id),
  action        scan_action not null,
  location_id   uuid references locations(id),
  scanned_by    uuid references profiles(id),
  device_id     text,
  app_version   text,
  is_offline_sync boolean not null default false,  -- discan saat offline, sync belakangan
  client_ts     timestamptz,                       -- waktu di HP (bisa beda dari server)
  success       boolean not null default true,
  error_code    text,                              -- LOT_EXPIRED, HALAL_EXPIRED, WRONG_LOCATION, NOT_FOUND
  batch_id      uuid references production_batches(id),
  doc_id        uuid,
  remarks       text
);
create index idx_scan_time on scan_events(scanned_at desc);
create index idx_scan_hu   on scan_events(hu_id);
create index idx_scan_user on scan_events(scanned_by, scanned_at desc);
create index idx_scan_fail on scan_events(error_code) where success = false;

alter table stock_movements
  add constraint fk_mv_scan foreign key (scan_event_id) references scan_events(id);

-- =====================================================================
-- 9. PENOMORAN DOKUMEN
-- =====================================================================
create table number_sequences (
  prefix      text primary key,                    -- LOT, GRN, DO, BTC, NF-HU
  period      text not null,                       -- '2608' (YYMM) atau 'ALL'
  last_number bigint not null default 0,
  padding     smallint not null default 4
);

create or replace function next_doc_no(p_prefix text, p_use_period boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_period text := case when p_use_period then to_char(now() at time zone 'Asia/Jakarta','YYMM') else 'ALL' end;
  v_num bigint;
  v_pad smallint;
begin
  insert into number_sequences(prefix, period, last_number)
  values (p_prefix, v_period, 1)
  on conflict (prefix) do update
    set last_number = case when number_sequences.period = v_period
                           then number_sequences.last_number + 1 else 1 end,
        period = v_period
  returning last_number, padding into v_num, v_pad;

  return p_prefix || '-' || v_period || '-' || lpad(v_num::text, v_pad, '0');
end;
$$;

-- =====================================================================
-- 10. ATURAN BISNIS (trigger & fungsi)
-- =====================================================================

-- 10a. lot boleh dipakai? dipanggil sebelum ISSUE / SHIPMENT / konsumsi batch
create or replace function assert_lot_usable(p_lot_id uuid)
returns void language plpgsql stable as $$
declare l record;
begin
  select lo.*, it.requires_halal_cert into l
  from lots lo join items it on it.id = lo.item_id
  where lo.id = p_lot_id;

  if not found then raise exception 'LOT_NOT_FOUND'; end if;
  if l.status <> 'RELEASED' then
    raise exception 'LOT_NOT_RELEASED: lot % berstatus %', l.lot_code, l.status;
  end if;
  if l.expiry_date is not null and l.expiry_date < current_date then
    raise exception 'LOT_EXPIRED: lot % kedaluwarsa %', l.lot_code, l.expiry_date;
  end if;
  if l.requires_halal_cert and l.halal_valid_until is not null
     and l.halal_valid_until < current_date then
    raise exception 'HALAL_EXPIRED: sertifikat halal lot % habis %', l.lot_code, l.halal_valid_until;
  end if;
end;
$$;

create or replace function trg_check_consumption() returns trigger
language plpgsql as $$
begin
  perform assert_lot_usable(new.lot_id);
  if new.unit_cost is null then
    select unit_cost into new.unit_cost from lots where id = new.lot_id;
  end if;
  return new;
end;
$$;
create trigger t_batch_consumption_check
  before insert on batch_consumption
  for each row execute function trg_check_consumption();

-- 10b. HU: kurangi/tambah sisa qty dari setiap pergerakan
create or replace function trg_apply_movement_to_hu() returns trigger
language plpgsql as $$
begin
  if new.hu_id is not null then
    update handling_units
       set qty_remaining = qty_remaining + new.qty,
           location_id   = coalesce(new.to_location_id, location_id),
           status        = case when qty_remaining + new.qty <= 0 then 'EMPTY'::hu_status else status end
     where id = new.hu_id;
  end if;
  return new;
end;
$$;
create trigger t_movement_hu
  after insert on stock_movements
  for each row execute function trg_apply_movement_to_hu();

-- 10c. buku besar tidak boleh diubah/dihapus — koreksi lewat ADJUSTMENT
create or replace function trg_movements_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'STOCK_MOVEMENTS_IMMUTABLE: buat entri ADJUSTMENT, jangan ubah riwayat';
end;
$$;
create trigger t_movements_no_update before update or delete on stock_movements
  for each row execute function trg_movements_immutable();

-- 10d. catat riwayat status lot
create or replace function trg_lot_status_history() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    insert into lot_status_history(lot_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
    new.status_changed_at := now();
    new.status_changed_by := auth.uid();
  end if;
  return new;
end;
$$;
create trigger t_lot_status before update on lots
  for each row execute function trg_lot_status_history();

-- 10e. saran FEFO — dipakai layar produksi di HP
create or replace function suggest_lots_fefo(p_item_id uuid, p_qty numeric)
returns table (
  lot_id uuid, lot_code text, hu_id uuid, hu_code text,
  qty_available numeric, expiry_date date, location_code text, suggested_qty numeric
) language sql stable as $$
  with avail as (
    select l.id, l.lot_code, h.id hu, h.hu_code, h.qty_remaining, l.expiry_date, lc.code loc,
           sum(h.qty_remaining) over (order by l.expiry_date, l.lot_code, h.hu_code
                                      rows between unbounded preceding and current row) running
    from lots l
    join handling_units h on h.lot_id = l.id and h.status = 'ACTIVE' and h.qty_remaining > 0
    left join locations lc on lc.id = h.location_id
    where l.item_id = p_item_id
      and l.status = 'RELEASED'
      and (l.expiry_date is null or l.expiry_date >= current_date)
      and (l.halal_valid_until is null or l.halal_valid_until >= current_date)
  )
  select id, lot_code, hu, hu_code, qty_remaining, expiry_date, loc,
         least(qty_remaining, p_qty - (running - qty_remaining))
  from avail
  where running - qty_remaining < p_qty
  order by expiry_date, lot_code;
$$;

-- 10f. resolusi QR: satu panggilan dari HP saat scan
create or replace function resolve_qr(p_token uuid, p_action scan_action default 'LOOKUP',
                                      p_location_id uuid default null, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; v_hu uuid; v_err text;
begin
  select to_jsonb(x) into v from (
    select h.id hu_id, h.hu_code, h.qty_remaining, h.uom, h.status hu_status,
           l.id lot_id, l.lot_code, l.expiry_date, l.halal_valid_until, l.status lot_status,
           l.owner_type, p.name owner_name,
           i.code item_code, i.name item_name, i.type item_type,
           lc.code location_code,
           (l.expiry_date < current_date) is_expired,
           (l.halal_valid_until < current_date) is_halal_expired,
           coalesce((select array_agg(a.code) from lot_allergens la
                     join allergens a on a.id = la.allergen_id
                     where la.lot_id = l.id), '{}') allergens
    from handling_units h
    join lots l on l.id = h.lot_id
    join items i on i.id = l.item_id
    left join partners p on p.id = l.owner_partner_id
    left join locations lc on lc.id = h.location_id
    where h.qr_token = p_token
  ) x;

  if v is null then
    v_err := 'NOT_FOUND';
  else
    v_hu := (v->>'hu_id')::uuid;
    if (v->>'is_expired')::boolean then v_err := 'LOT_EXPIRED';
    elsif (v->>'is_halal_expired')::boolean then v_err := 'HALAL_EXPIRED';
    elsif (v->>'lot_status') <> 'RELEASED' and p_action <> 'LOOKUP' then v_err := 'LOT_NOT_RELEASED';
    end if;
  end if;

  insert into scan_events(qr_token, hu_id, action, location_id, scanned_by, device_id,
                          success, error_code)
  values (p_token, v_hu, p_action, p_location_id, auth.uid(), p_device,
          v_err is null, v_err);

  return coalesce(v, '{}'::jsonb) || jsonb_build_object('ok', v_err is null, 'error', v_err);
end;
$$;

-- =====================================================================
-- 11. VIEW UNTUK DASHBOARD & AUDIT
-- =====================================================================

-- stok on-hand per lot
create view v_stock_on_hand as
select l.id lot_id, l.lot_code, i.code item_code, i.name item_name, i.type item_type,
       l.owner_type, p.name owner_name, l.expiry_date, l.halal_valid_until, l.status lot_status,
       sum(h.qty_remaining) qty_on_hand, h.uom,
       count(*) filter (where h.status='ACTIVE') hu_count
from lots l
join items i on i.id = l.item_id
left join partners p on p.id = l.owner_partner_id
left join handling_units h on h.lot_id = l.id and h.status='ACTIVE'
group by l.id, l.lot_code, i.code, i.name, i.type, l.owner_type, p.name,
         l.expiry_date, l.halal_valid_until, l.status, h.uom;

-- telusur maju: satu lot bahan dipakai di batch apa, dikirim ke siapa
create view v_trace_forward as
select bc.lot_id            as source_lot_id,
       sl.lot_code          as source_lot_code,
       si.name              as source_item,
       pb.id                as batch_id,
       pb.batch_no,
       pb.item_id           as product_item_id,
       pi.name              as product_name,
       bc.qty_actual        as qty_used,
       pb.output_lot_id,
       dol.do_id,
       d.doc_no             as do_no,
       c.name               as customer_name,
       dol.qty              as qty_shipped,
       d.shipped_at,
       d.status             as do_status
from batch_consumption bc
join lots sl              on sl.id = bc.lot_id
join items si             on si.id = sl.item_id
join production_batches pb on pb.id = bc.batch_id
join items pi             on pi.id = pb.item_id
left join delivery_order_lines dol on dol.lot_id = pb.output_lot_id
left join delivery_orders d on d.id = dol.do_id
left join partners c      on c.id = d.customer_id;

-- rekonsiliasi bahan titipan klien
create view v_consignment_balance as
select p.id customer_id, p.name customer_name, i.code item_code, i.name item_name,
       sum(l.qty_received) qty_received,
       coalesce(sum(bc.qty_used),0) qty_consumed,
       sum(coalesce(h.qty_on_hand,0)) qty_on_hand,
       sum(l.qty_received) - coalesce(sum(bc.qty_used),0) - sum(coalesce(h.qty_on_hand,0)) qty_variance
from lots l
join partners p on p.id = l.owner_partner_id
join items i on i.id = l.item_id
left join lateral (select sum(qty_actual) qty_used from batch_consumption where lot_id = l.id) bc on true
left join lateral (select sum(qty_remaining) qty_on_hand from handling_units where lot_id = l.id and status='ACTIVE') h on true
where l.owner_type = 'CONSIGNED'
group by p.id, p.name, i.code, i.name;

-- HPP aktual per batch
create view v_batch_cost as
select pb.id batch_id, pb.batch_no, i.name product_name, pb.target_qty, pb.actual_qty,
       pb.reject_qty, pb.yield_pct, f.std_yield_pct,
       coalesce(mc.material_cost,0) material_cost,
       coalesce(oc.other_cost,0)    other_cost,
       coalesce(mc.material_cost,0) + coalesce(oc.other_cost,0) total_cost,
       case when pb.actual_qty > 0
            then round((coalesce(mc.material_cost,0)+coalesce(oc.other_cost,0)) / pb.actual_qty, 2)
       end actual_cost_per_uom,
       i.standard_cost,
       case when pb.actual_qty > 0 and i.standard_cost > 0
            then round(((coalesce(mc.material_cost,0)+coalesce(oc.other_cost,0)) / pb.actual_qty
                        - i.standard_cost) / i.standard_cost * 100, 2)
       end variance_pct
from production_batches pb
join items i on i.id = pb.item_id
left join formulas f on f.id = pb.formula_id
left join lateral (select sum(line_cost) material_cost from batch_consumption where batch_id = pb.id) mc on true
left join lateral (select sum(amount) other_cost from batch_costs where batch_id = pb.id) oc on true;

-- peringatan expiry & halal
create view v_alerts_expiring as
select l.id lot_id, l.lot_code, i.name item_name,
       sum(h.qty_remaining) qty,
       l.expiry_date, (l.expiry_date - current_date) days_to_expiry,
       l.halal_valid_until, (l.halal_valid_until - current_date) days_to_halal_expiry,
       sum(h.qty_remaining) * coalesce(l.unit_cost,0) value_at_risk
from lots l
join items i on i.id = l.item_id
join handling_units h on h.lot_id = l.id and h.status='ACTIVE' and h.qty_remaining > 0
where l.status = 'RELEASED'
  and (l.expiry_date <= current_date + 14 or l.halal_valid_until <= current_date + 30)
group by l.id, l.lot_code, i.name, l.expiry_date, l.halal_valid_until, l.unit_cost;

-- monitoring aktivitas scan (produktivitas gudang & error rate)
create view v_scan_activity as
select date_trunc('hour', scanned_at) bucket,
       pr.full_name, se.action, se.success, se.error_code,
       count(*) scan_count
from scan_events se
left join profiles pr on pr.id = se.scanned_by
group by 1,2,3,4,5;

-- =====================================================================
-- 12. RLS
-- =====================================================================
alter table profiles              enable row level security;
alter table locations             enable row level security;
alter table partners              enable row level security;
alter table items                 enable row level security;
alter table item_allergens        enable row level security;
alter table item_uom_conversions  enable row level security;
alter table allergens             enable row level security;
alter table formulas              enable row level security;
alter table formula_lines         enable row level security;
alter table ccp_definitions       enable row level security;
alter table lots                  enable row level security;
alter table lot_allergens         enable row level security;
alter table lot_status_history    enable row level security;
alter table handling_units        enable row level security;
alter table label_prints          enable row level security;
alter table goods_receipts        enable row level security;
alter table goods_receipt_lines   enable row level security;
alter table delivery_orders       enable row level security;
alter table delivery_order_lines  enable row level security;
alter table stock_counts          enable row level security;
alter table stock_count_lines     enable row level security;
alter table production_batches    enable row level security;
alter table batch_consumption     enable row level security;
alter table ccp_readings          enable row level security;
alter table batch_costs           enable row level security;
alter table stock_movements       enable row level security;
alter table scan_events           enable row level security;
alter table number_sequences      enable row level security;

-- semua pengguna aktif boleh membaca data operasional
do $$
declare t text;
begin
  foreach t in array array[
    'locations','partners','items','item_allergens','item_uom_conversions','allergens',
    'formulas','formula_lines','ccp_definitions','lots','lot_allergens','lot_status_history',
    'handling_units','label_prints','goods_receipts','goods_receipt_lines',
    'delivery_orders','delivery_order_lines','stock_counts','stock_count_lines',
    'production_batches','batch_consumption','ccp_readings','stock_movements','scan_events'
  ] loop
    execute format(
      'create policy p_read_%1$s on %1$I for select to authenticated using (
         exists (select 1 from profiles where id = auth.uid() and is_active))', t);
  end loop;
end $$;

-- biaya hanya untuk finance/admin/QA
create policy p_read_batch_costs on batch_costs for select to authenticated
  using (current_role_is('FINANCE','ADMIN','QA','PLANNER'));

-- gudang & operator: transaksi harian
create policy p_wh_write_hu on handling_units for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_write_grn on goods_receipts for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_write_grn_l on goods_receipt_lines for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_write_do on delivery_orders for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_wh_write_do_l on delivery_order_lines for all to authenticated
  using (current_role_is('WAREHOUSE','ADMIN')) with check (current_role_is('WAREHOUSE','ADMIN'));
create policy p_op_write_consumption on batch_consumption for insert to authenticated
  with check (current_role_is('OPERATOR','WAREHOUSE','ADMIN'));
create policy p_op_write_batch on production_batches for all to authenticated
  using (current_role_is('OPERATOR','PLANNER','ADMIN')) with check (current_role_is('OPERATOR','PLANNER','ADMIN'));
create policy p_mv_insert on stock_movements for insert to authenticated
  with check (current_role_is('OPERATOR','WAREHOUSE','ADMIN'));
create policy p_scan_insert on scan_events for insert to authenticated
  with check (exists (select 1 from profiles where id = auth.uid() and is_active));

-- QA: pelepasan lot, CCP, master mutu
create policy p_qa_lot on lots for all to authenticated
  using (current_role_is('QA','WAREHOUSE','ADMIN')) with check (current_role_is('QA','WAREHOUSE','ADMIN'));
create policy p_qa_ccp_read on ccp_readings for all to authenticated
  using (current_role_is('QA','OPERATOR','ADMIN')) with check (current_role_is('QA','OPERATOR','ADMIN'));
create policy p_qa_ccp_def on ccp_definitions for all to authenticated
  using (current_role_is('QA','ADMIN')) with check (current_role_is('QA','ADMIN'));

-- master data: admin
create policy p_admin_items on items for all to authenticated
  using (current_role_is('ADMIN','PLANNER')) with check (current_role_is('ADMIN','PLANNER'));
create policy p_admin_partners on partners for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));
create policy p_admin_locations on locations for all to authenticated
  using (current_role_is('ADMIN','WAREHOUSE')) with check (current_role_is('ADMIN','WAREHOUSE'));
create policy p_admin_formulas on formulas for all to authenticated
  using (current_role_is('ADMIN','PLANNER','QA')) with check (current_role_is('ADMIN','PLANNER','QA'));

-- profil: baca sendiri, admin baca semua
create policy p_profile_self on profiles for select to authenticated
  using (id = auth.uid() or current_role_is('ADMIN'));
create policy p_profile_admin on profiles for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));

-- =====================================================================
-- 13. REALTIME (monitoring layar desktop)
-- =====================================================================
alter publication supabase_realtime add table scan_events;
alter publication supabase_realtime add table stock_movements;
alter publication supabase_realtime add table production_batches;

-- =====================================================================
-- 14. SEED MINIMUM
-- =====================================================================
insert into allergens(id, code, name_id, name_en) values
 (1,'SOY','Kedelai','Soy'),
 (2,'WHEAT','Gandum','Wheat'),
 (3,'CRUSTACEAN','Krustasea','Crustacean'),
 (4,'MILK','Susu','Milk'),
 (5,'EGG','Telur','Egg'),
 (6,'FISH','Ikan','Fish'),
 (7,'PEANUT','Kacang tanah','Peanut'),
 (8,'TREENUT','Kacang pohon','Tree nut'),
 (9,'SULPHITE','Sulfit','Sulphite')
on conflict do nothing;

insert into number_sequences(prefix, period, last_number, padding) values
 ('LOT', to_char(now(),'YYMM'), 0, 4),
 ('NF-HU', to_char(now(),'YYMM'), 0, 6),
 ('GRN', to_char(now(),'YYMM'), 0, 4),
 ('DO',  to_char(now(),'YYMM'), 0, 4),
 ('BTC', to_char(now(),'YYMM'), 0, 3),
 ('OPN', to_char(now(),'YYMM'), 0, 3)
on conflict do nothing;

insert into locations(code,name,type) values
 ('GBB-01','Gudang Bahan Baku','RAW'),
 ('GBB-QR','Area Karantina Bahan','QUARANTINE'),
 ('WIP-L2','WIP Line Saus 2','WIP'),
 ('PRD-L2','Line Saus 2','PRODUCTION'),
 ('GFG-01','Gudang Produk Jadi','FINISHED'),
 ('STG-01','Staging Pengiriman','STAGING'),
 ('REJ-01','Area Reject','REJECT')
on conflict do nothing;
