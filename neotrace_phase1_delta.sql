-- =====================================================================
-- NEOTRACE — FASE 1 (delta di atas v1)
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- CAKUPAN FASE 1
--   v1 penuh  : lot, handling unit + QR, buku besar pergerakan, GRN, DO,
--               stock opname, batch produksi, CCP, HPP, titipan klien
--   + delta ini: QC hold & release, retain sample, penegakan FEFO,
--               peringatan kedaluwarsa 90/60/30, blokir otomatis
--
-- TIDAK TERMASUK (ditunda ke Fase 2+): put-away otomatis, cross-docking,
--   zonasi alergen rak, pick list & wave picking, packing, barcode/RFID
--   selain QR, integrasi ERP, KPI tenaga kerja, forecasting, dual UoM.
--
-- PRASYARAT: neotrace_schema.sql (v1) sudah dijalankan.
-- JANGAN jalankan neotrace_schema_v2_wms.sql pada fase ini.
-- =====================================================================

-- =====================================================================
-- BAGIAN 0 — JALANKAN SENDIRI DULU (enum baru tidak boleh dipakai
--            pada transaksi yang sama)
-- =====================================================================
alter type lot_status add value if not exists 'BLOCKED';

-- ==== berhenti di sini, lalu jalankan sisa file sebagai batch kedua ====


-- =====================================================================
-- BAGIAN 1 — QC HOLD, UJI LAB, RETAIN SAMPLE
-- =====================================================================
create type qc_test_type as enum ('MICROBIOLOGY','ORGANOLEPTIC','CHEMICAL','PHYSICAL','ALLERGEN','FOREIGN_BODY');
create type sample_type  as enum ('INCOMING','IN_PROCESS','RETAIN','COMPLAINT');

create table qc_samples (
  id                  uuid primary key default gen_random_uuid(),
  sample_no           text not null unique,          -- SMP-2608-0031
  type                sample_type not null,
  lot_id              uuid references lots(id),
  batch_id            uuid references production_batches(id),
  hu_id               uuid references handling_units(id),
  qty                 numeric(18,3),
  uom                 text,
  taken_at            timestamptz not null default now(),
  taken_by            uuid references profiles(id),
  storage_location_id uuid references locations(id),
  retain_until        date,                          -- retain sample: masa edar + margin
  disposed_at         timestamptz,
  disposed_by         uuid references profiles(id),
  remarks             text,
  constraint chk_sample_target check (num_nonnulls(lot_id, batch_id) >= 1)
);
create index idx_sample_lot    on qc_samples(lot_id);
create index idx_sample_batch  on qc_samples(batch_id);
create index idx_sample_retain on qc_samples(retain_until) where disposed_at is null;

create table qc_tests (
  id              uuid primary key default gen_random_uuid(),
  sample_id       uuid not null references qc_samples(id) on delete cascade,
  test_type       qc_test_type not null,
  parameter       text not null,                     -- TPC, E.coli, Salmonella, pH, warna, aroma
  method          text,                              -- SNI / AOAC / internal
  is_mandatory    boolean not null default true,     -- hanya uji wajib yang memblokir release
  spec_min        numeric(18,4),
  spec_max        numeric(18,4),
  spec_text       text,                              -- 'negatif / 25 g'
  result_num      numeric(18,4),
  result_text     text,
  result          qc_result not null default 'PENDING',
  tested_at       timestamptz,
  tested_by       uuid references profiles(id),
  lab_name        text,
  attachment_path text                               -- Supabase Storage
);
create index idx_test_sample on qc_tests(sample_id);

-- evaluasi otomatis PASS/FAIL terhadap spesifikasi numerik ATAU teks.
-- Cabang teks ditambahkan setelah ditemukan live (16 Aug 2026): tanpa itu,
-- uji dengan spec_text saja (organoleptik — aroma, warna, rasa) tidak
-- pernah punya jalur untuk berubah dari PENDING, sehingga release_lot()
-- terkunci selamanya untuk lot manapun yang punya uji wajib bertipe teks.
create or replace function trg_eval_qc_test() returns trigger
language plpgsql as $$
begin
  if new.result_num is not null and (new.spec_min is not null or new.spec_max is not null) then
    new.result := case
      when (new.spec_min is not null and new.result_num < new.spec_min)
        or (new.spec_max is not null and new.result_num > new.spec_max)
      then 'FAIL'::qc_result else 'PASS'::qc_result end;
    new.tested_at := coalesce(new.tested_at, now());
  elsif new.result_text is not null and new.spec_text is not null then
    new.result := case
      when lower(trim(new.result_text)) = lower(trim(new.spec_text))
      then 'PASS'::qc_result else 'FAIL'::qc_result end;
    new.tested_at := coalesce(new.tested_at, now());
  end if;
  return new;
end;
$$;
create trigger t_qc_test_eval before insert or update on qc_tests
  for each row execute function trg_eval_qc_test();

-- release lot: hanya QA, dan hanya bila seluruh uji wajib sudah PASS
create or replace function release_lot(p_lot_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_pending int; v_fail int; v_code text;
begin
  if not current_role_is('QA','ADMIN') then
    raise exception 'FORBIDDEN: hanya QA yang boleh melepas lot';
  end if;

  select lot_code into v_code from lots where id = p_lot_id;
  if v_code is null then raise exception 'LOT_NOT_FOUND'; end if;

  select count(*) filter (where t.result = 'PENDING'),
         count(*) filter (where t.result = 'FAIL')
    into v_pending, v_fail
  from qc_samples s
  join qc_tests t on t.sample_id = s.id and t.is_mandatory
  where s.lot_id = p_lot_id and s.type = 'INCOMING';

  if v_fail > 0    then raise exception 'QC_FAILED: lot % memiliki % uji wajib gagal', v_code, v_fail; end if;
  if v_pending > 0 then raise exception 'QC_PENDING: lot % masih menunggu % hasil uji', v_code, v_pending; end if;

  update lots set status = 'RELEASED', remarks = coalesce(p_reason, remarks) where id = p_lot_id;
end;
$$;

-- tahan lot (mis. hasil uji ulang gagal, komplain klien) — memblokir pemakaian
create or replace function hold_lot(p_lot_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not current_role_is('QA','ADMIN') then
    raise exception 'FORBIDDEN: hanya QA yang boleh menahan lot';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED';
  end if;
  update lots set status = 'HOLD', remarks = p_reason where id = p_lot_id;
end;
$$;

-- karantina massal untuk recall: kunci seluruh lot turunan dari satu lot bahan
create or replace function quarantine_lot_cascade(p_source_lot_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lots int; v_batches int;
begin
  if not current_role_is('QA','ADMIN') then
    raise exception 'FORBIDDEN: hanya QA yang boleh menjalankan recall';
  end if;

  update lots set status = 'BLOCKED', remarks = p_reason where id = p_source_lot_id;

  with affected as (
    select distinct pb.output_lot_id lot_id, pb.id batch_id
    from batch_consumption bc
    join production_batches pb on pb.id = bc.batch_id
    where bc.lot_id = p_source_lot_id and pb.output_lot_id is not null
  ), upd_lot as (
    update lots l set status = 'BLOCKED',
      remarks = concat_ws(' | ', l.remarks, 'RECALL: ' || p_reason)
    from affected a where l.id = a.lot_id returning 1
  ), upd_batch as (
    update production_batches pb set qc_result = 'FAIL', status = 'QC_HOLD'
    from affected a where pb.id = a.batch_id returning 1
  )
  select (select count(*) from upd_lot), (select count(*) from upd_batch)
    into v_lots, v_batches;

  insert into notifications(type, severity, title, body, lot_id, target_role)
  values ('QC_PENDING','CRITICAL',
          'RECALL dijalankan',
          format('%s lot produk jadi dan %s batch dikunci. Alasan: %s', v_lots, v_batches, p_reason),
          p_source_lot_id, 'QA');

  return jsonb_build_object('source_lot', p_source_lot_id,
                            'blocked_lots', v_lots, 'held_batches', v_batches);
end;
$$;

-- =====================================================================
-- BAGIAN 2 — PENEGAKAN FEFO
-- =====================================================================
alter table items add column if not exists enforce_fefo boolean not null default true;

-- tolak lot yang lebih baru bila masih ada lot lain lebih dekat kedaluwarsa
create or replace function assert_fefo(p_item_id uuid, p_lot_id uuid)
returns void language plpgsql stable as $$
declare v_exp date; v_earlier text; v_enforce boolean;
begin
  select enforce_fefo into v_enforce from items where id = p_item_id;
  if not coalesce(v_enforce, true) then return; end if;

  select expiry_date into v_exp from lots where id = p_lot_id;
  if v_exp is null then return; end if;

  select string_agg(l.lot_code || ' (exp ' || l.expiry_date || ')', ', ')
    into v_earlier
  from lots l
  where l.item_id = p_item_id
    and l.status = 'RELEASED'
    and l.id <> p_lot_id
    and l.expiry_date < v_exp
    and exists (select 1 from handling_units h
                where h.lot_id = l.id and h.status = 'ACTIVE' and h.qty_remaining > 0);

  if v_earlier is not null then
    raise exception 'FEFO_VIOLATION: masih ada lot lebih dekat kedaluwarsa — %', v_earlier;
  end if;
end;
$$;

-- pasang di konsumsi batch: boleh dilanggar HANYA dengan fefo_override + alasan
create or replace function trg_check_consumption() returns trigger
language plpgsql as $$
begin
  perform assert_lot_usable(new.lot_id);

  if not new.fefo_override then
    perform assert_fefo(new.item_id, new.lot_id);
  else
    insert into notifications(type, severity, title, body, lot_id, batch_id, target_role)
    values ('FEFO_OVERRIDE','WARN','FEFO dilanggar dengan alasan',
            new.override_reason, new.lot_id, new.batch_id, 'QA');
  end if;

  if new.unit_cost is null then
    select unit_cost into new.unit_cost from lots where id = new.lot_id;
  end if;
  return new;
end;
$$;
-- trigger t_batch_consumption_check dari v1 otomatis memakai fungsi baru ini.

-- =====================================================================
-- BAGIAN 3 — PERINGATAN KEDALUWARSA & BLOKIR OTOMATIS
-- =====================================================================
create type alert_type    as enum ('EXPIRY','HALAL_EXPIRY','LOW_STOCK','QC_PENDING','RETAIN_DUE','FEFO_OVERRIDE');
create type alert_channel as enum ('IN_APP','EMAIL','WHATSAPP','WEBHOOK');

create table alert_rules (
  id              uuid primary key default gen_random_uuid(),
  type            alert_type not null,
  item_id         uuid references items(id),          -- null = berlaku semua item
  threshold_days  smallint[],                         -- '{90,60,30,14,7}'
  threshold_qty   numeric(18,3),
  channels        alert_channel[] not null default '{IN_APP}',
  recipient_roles user_role[] not null default '{WAREHOUSE,QA}',
  is_active       boolean not null default true
);

create table notifications (
  id          bigserial primary key,
  type        alert_type not null,
  severity    text not null default 'INFO',           -- INFO / WARN / CRITICAL
  title       text not null,
  body        text,
  lot_id      uuid references lots(id),
  item_id     uuid references items(id),
  batch_id    uuid references production_batches(id),
  target_role user_role,
  target_user uuid references profiles(id),
  dedup_key   text,                                   -- cegah notifikasi ganda per hari
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  acted_at    timestamptz,
  acted_by    uuid references profiles(id)
);
create unique index idx_notif_dedup on notifications(dedup_key) where dedup_key is not null;
create index idx_notif_open on notifications(target_role, created_at desc) where read_at is null;

-- job harian: blokir yang sudah lewat, notifikasi yang mendekati
create or replace function run_daily_expiry_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_blocked int := 0; v_expiry int := 0; v_halal int := 0; v_retain int := 0;
begin
  -- 1. blokir lot kedaluwarsa atau sertifikat halal habis
  with upd as (
    update lots set status = 'BLOCKED',
      remarks = concat_ws(' | ', remarks,
        case when expiry_date < current_date then 'AUTO-BLOCK: kedaluwarsa'
             else 'AUTO-BLOCK: sertifikat halal habis' end)
    where status = 'RELEASED'
      and (expiry_date < current_date or halal_valid_until < current_date)
    returning 1
  ) select count(*) into v_blocked from upd;

  -- 2. peringatan kedaluwarsa pada ambang 90/60/30/14/7 hari
  with ins as (
    insert into notifications(type, severity, title, body, lot_id, item_id, target_role, dedup_key)
    select 'EXPIRY',
           case when l.expiry_date - current_date <= 14 then 'CRITICAL'
                when l.expiry_date - current_date <= 30 then 'WARN' else 'INFO' end,
           'Lot ' || l.lot_code || ' mendekati kedaluwarsa',
           i.name || ' · sisa ' || (l.expiry_date - current_date) || ' hari · '
             || round(sum(h.qty_remaining),2) || ' ' || i.base_uom
             || ' · nilai Rp ' || to_char(sum(h.qty_remaining) * coalesce(l.unit_cost,0), 'FM999,999,999'),
           l.id, i.id, 'WAREHOUSE',
           'EXP:' || l.id || ':' || (l.expiry_date - current_date)
    from lots l
    join items i on i.id = l.item_id
    join handling_units h on h.lot_id = l.id and h.status = 'ACTIVE' and h.qty_remaining > 0
    where l.status = 'RELEASED' and (l.expiry_date - current_date) in (90,60,30,14,7)
    group by l.id, l.lot_code, l.expiry_date, l.unit_cost, i.id, i.name, i.base_uom
    on conflict (dedup_key) do nothing
    returning 1
  ) select count(*) into v_expiry from ins;

  -- 3. peringatan sertifikat halal supplier
  with ins as (
    insert into notifications(type, severity, title, body, lot_id, item_id, target_role, dedup_key)
    select 'HALAL_EXPIRY', 'CRITICAL',
           'Sertifikat halal lot ' || l.lot_code || ' akan habis',
           i.name || ' · supplier ' || coalesce(p.name,'-')
             || ' · sisa ' || (l.halal_valid_until - current_date) || ' hari',
           l.id, i.id, 'QA',
           'HAL:' || l.id || ':' || (l.halal_valid_until - current_date)
    from lots l
    join items i on i.id = l.item_id
    left join partners p on p.id = l.supplier_id
    where l.status = 'RELEASED' and i.requires_halal_cert
      and (l.halal_valid_until - current_date) in (60,30,14,7)
    on conflict (dedup_key) do nothing
    returning 1
  ) select count(*) into v_halal from ins;

  -- 4. retain sample jatuh tempo pemusnahan
  with ins as (
    insert into notifications(type, severity, title, body, lot_id, target_role, dedup_key)
    select 'RETAIN_DUE', 'INFO',
           'Retain sample ' || s.sample_no || ' jatuh tempo',
           'Simpan sampai ' || s.retain_until || ' · siap dimusnahkan',
           s.lot_id, 'QA', 'RET:' || s.id
    from qc_samples s
    where s.type = 'RETAIN' and s.disposed_at is null and s.retain_until <= current_date
    on conflict (dedup_key) do nothing
    returning 1
  ) select count(*) into v_retain from ins;

  return jsonb_build_object('blocked', v_blocked, 'expiry_alerts', v_expiry,
                            'halal_alerts', v_halal, 'retain_alerts', v_retain,
                            'ran_at', now());
end;
$$;

-- jadwalkan 00:05 WIB = 17:05 UTC (aktifkan extension pg_cron di dashboard Supabase)
-- select cron.schedule('neotrace-daily', '5 17 * * *', $$select run_daily_expiry_jobs()$$);

-- =====================================================================
-- BAGIAN 4 — VIEW PENDUKUNG FASE 1
-- =====================================================================
create or replace view v_qc_pending as
select l.id lot_id, l.lot_code, i.name item_name, p.name supplier_name,
       l.received_at, l.status,
       count(t.id) total_tests,
       count(t.id) filter (where t.result = 'PENDING') pending_tests,
       count(t.id) filter (where t.result = 'FAIL')    failed_tests,
       round(extract(epoch from (now() - l.received_at))/3600.0, 1) hours_on_hold
from lots l
join items i on i.id = l.item_id
left join partners p on p.id = l.supplier_id
left join qc_samples s on s.lot_id = l.id and s.type = 'INCOMING'
left join qc_tests t on t.sample_id = s.id
where l.status = 'QUARANTINE'
group by l.id, l.lot_code, i.name, p.name, l.received_at, l.status;

create or replace view v_fefo_compliance as
select date_trunc('week', bc.consumed_at) week,
       count(*) total_picks,
       count(*) filter (where bc.fefo_override) overrides,
       round(100 - count(*) filter (where bc.fefo_override)::numeric
             / nullif(count(*),0) * 100, 2) compliance_pct
from batch_consumption bc
group by 1 order by 1 desc;

-- =====================================================================
-- BAGIAN 5 — RLS
-- =====================================================================
alter table qc_samples   enable row level security;
alter table qc_tests     enable row level security;
alter table alert_rules  enable row level security;
alter table notifications enable row level security;

create policy p_read_qc_samples on qc_samples for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_read_qc_tests on qc_tests for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_read_alert_rules on alert_rules for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_read_notifications on notifications for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));

create policy p_qa_samples on qc_samples for all to authenticated
  using (current_role_is('QA','ADMIN')) with check (current_role_is('QA','ADMIN'));
create policy p_qa_tests on qc_tests for all to authenticated
  using (current_role_is('QA','ADMIN')) with check (current_role_is('QA','ADMIN'));
create policy p_admin_alert_rules on alert_rules for all to authenticated
  using (current_role_is('QA','ADMIN')) with check (current_role_is('QA','ADMIN'));
create policy p_notif_ack on notifications for update to authenticated
  using (target_user = auth.uid() or current_role_is('QA','WAREHOUSE','ADMIN'));

alter publication supabase_realtime add table notifications;

-- =====================================================================
-- BAGIAN 6 — SEED
-- =====================================================================
insert into number_sequences(prefix, period, last_number, padding)
values ('SMP', to_char(now(),'YYMM'), 0, 4)
on conflict do nothing;

insert into alert_rules(type, threshold_days, channels, recipient_roles) values
 ('EXPIRY',       '{90,60,30,14,7}', '{IN_APP,EMAIL}', '{WAREHOUSE,PLANNER}'),
 ('HALAL_EXPIRY', '{60,30,14,7}',    '{IN_APP,EMAIL}', '{QA,ADMIN}'),
 ('RETAIN_DUE',   '{0}',             '{IN_APP}',       '{QA}'),
 ('FEFO_OVERRIDE', null,             '{IN_APP}',       '{QA,WAREHOUSE}')
on conflict do nothing;
