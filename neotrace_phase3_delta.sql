-- =====================================================================
-- NEOTRACE — FASE 3 (delta di atas v1 + Fase 1 + Fase 2)
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- CAKUPAN FASE 3
--   1. Wave picking      : gabungkan beberapa batch dalam satu perjalanan
--   2. KPI tenaga kerja  : sesi kerja, produktivitas, akurasi pick
--   3. Dasbor perputaran : turnover, slow moving, klasifikasi ABC, utilisasi
--
-- TIDAK TERMASUK (Fase 4): integrasi ERP, forecasting.
-- PRASYARAT: v1 + neotrace_phase1_delta.sql + neotrace_phase2_delta.sql
-- =====================================================================

-- =====================================================================
-- BAGIAN 0 — JALANKAN SENDIRI DULU
-- =====================================================================
alter type pick_status add value if not exists 'PAUSED';

-- ==== berhenti di sini, jalankan sisa file sebagai batch kedua ========


-- =====================================================================
-- BAGIAN 1 — WAVE PICKING
-- =====================================================================
create type pick_strategy as enum ('DISCRETE','BATCH','ZONE','CLUSTER');

create table pick_waves (
  id            uuid primary key default gen_random_uuid(),
  wave_no       text not null unique,               -- WAV-2701-0012
  strategy      pick_strategy not null default 'BATCH',
  planned_for   timestamptz,
  zone_id       uuid references locations(id),      -- untuk strategi ZONE
  assigned_to   uuid references profiles(id),
  status        pick_status not null default 'OPEN',
  started_at    timestamptz,
  completed_at  timestamptz,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  notes         text
);
create index if not exists idx_wave_open on pick_waves(status) where status <> 'COMPLETED';

alter table pick_lists
  add column if not exists wave_id  uuid references pick_waves(id),
  add column if not exists zone_id  uuid references locations(id),
  add column if not exists strategy pick_strategy not null default 'DISCRETE';

alter table pick_list_lines
  add column if not exists wave_sequence integer,        -- urutan dalam gelombang
  add column if not exists tote_code     text;           -- wadah/keranjang per batch

create index if not exists idx_pll_wave on pick_list_lines(wave_sequence);

/**
 * Bentuk gelombang dari beberapa batch. Baris pick dari semua batch
 * diurutkan ulang mengikuti satu jalur gudang, sehingga petugas berjalan
 * sekali untuk banyak batch. Setiap batch mendapat kode tote sendiri agar
 * bahan tidak tercampur di troli.
 */
create or replace function generate_wave(
  p_batch_ids uuid[],
  p_strategy pick_strategy default 'BATCH',
  p_zone_id uuid default null,
  p_planned_for timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_wave uuid; v_pick uuid; b uuid; i int := 0; v_tote text;
begin
  if array_length(p_batch_ids, 1) is null then raise exception 'NO_BATCH'; end if;

  insert into pick_waves(wave_no, strategy, zone_id, planned_for, created_by)
  values (next_doc_no('WAV'), p_strategy, p_zone_id, p_planned_for, auth.uid())
  returning id into v_wave;

  foreach b in array p_batch_ids loop
    i := i + 1;
    v_tote := 'TOTE-' || lpad(i::text, 2, '0');

    select id into v_pick from pick_lists
     where batch_id = b and status <> 'CANCELLED' limit 1;

    if v_pick is null then
      v_pick := generate_pick_list_from_batch(b);
    end if;

    update pick_lists
       set wave_id = v_wave, strategy = p_strategy, zone_id = p_zone_id
     where id = v_pick;

    update pick_list_lines set tote_code = v_tote where pick_list_id = v_pick;
  end loop;

  -- satu urutan jalan untuk seluruh gelombang
  with ord as (
    select pll.id,
           row_number() over (order by coalesce(l.pick_sequence, 9999), l.code, pll.tote_code) * 10 rn
    from pick_list_lines pll
    join pick_lists pl on pl.id = pll.pick_list_id
    left join locations l on l.id = pll.from_location_id
    where pl.wave_id = v_wave
      and (p_zone_id is null or l.parent_id = p_zone_id or l.id = p_zone_id)
  )
  update pick_list_lines p set wave_sequence = ord.rn from ord where ord.id = p.id;

  if not exists (select 1 from pick_list_lines pll
                 join pick_lists pl on pl.id = pll.pick_list_id
                 where pl.wave_id = v_wave and pll.wave_sequence is not null) then
    delete from pick_waves where id = v_wave;
    raise exception 'EMPTY_WAVE: tidak ada baris pick yang masuk zona gelombang ini';
  end if;

  return v_wave;
end;
$$;

/**
 * Lembar kerja gelombang: baris digabung per lokasi agar petugas berhenti
 * sekali di tiap rak, lalu membagi ke beberapa tote.
 */
create or replace view v_wave_pick_sheet as
select w.id wave_id, w.wave_no, pll.wave_sequence,
       l.code location_code, l.rack_code, l.level_no,
       i.name item_name,
       lo.lot_code, h.hu_code,
       sum(pll.qty_requested) total_qty, pll.uom,
       jsonb_agg(jsonb_build_object(
         'tote', pll.tote_code, 'batch', pb.batch_no,
         'qty', pll.qty_requested, 'line_id', pll.id, 'status', pll.status
       ) order by pll.tote_code) splits,
       bool_and(pll.status in ('COMPLETED','SHORT')) all_done
from pick_waves w
join pick_lists pl on pl.wave_id = w.id
join pick_list_lines pll on pll.pick_list_id = pl.id
join items i on i.id = pll.item_id
left join lots lo on lo.id = pll.suggested_lot_id
left join handling_units h on h.id = pll.suggested_hu_id
left join locations l on l.id = pll.from_location_id
left join production_batches pb on pb.id = pl.batch_id
group by w.id, w.wave_no, pll.wave_sequence, l.code, l.rack_code, l.level_no,
         i.name, lo.lot_code, h.hu_code, pll.uom
order by pll.wave_sequence;

-- tutup gelombang otomatis bila seluruh baris selesai
create or replace function trg_close_wave() returns trigger
language plpgsql as $$
declare v_wave uuid;
begin
  select pl.wave_id into v_wave from pick_lists pl where pl.id = new.pick_list_id;
  if v_wave is null then return new; end if;

  if not exists (
    select 1 from pick_list_lines x
    join pick_lists p on p.id = x.pick_list_id
    where p.wave_id = v_wave and x.status in ('OPEN','ASSIGNED','IN_PROGRESS','PAUSED')
  ) then
    update pick_waves set status = 'COMPLETED', completed_at = now()
     where id = v_wave and status <> 'COMPLETED';
  end if;
  return new;
end;
$$;
create trigger t_close_wave after update of status on pick_list_lines
  for each row execute function trg_close_wave();

-- =====================================================================
-- BAGIAN 2 — KPI TENAGA KERJA
-- =====================================================================
create type task_type as enum
  ('RECEIVE','PUTAWAY','PICK','PACK','LOAD','COUNT','TRANSFER','PRODUCTION','CLEANING','OTHER');

create table labour_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id),
  task_type     task_type not null,
  reference_id  uuid,                                -- pick_list_id, wave_id, batch_id
  reference_no  text,
  zone_id       uuid references locations(id),
  device_id     text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  units_handled numeric(18,3),
  lines_handled integer,
  duration_min  numeric(10,2) generated always as (
    case when ended_at is not null
         then round(extract(epoch from (ended_at - started_at))/60.0, 2) end) stored,
  constraint chk_session_order check (ended_at is null or ended_at >= started_at)
);
create index if not exists idx_labour_user on labour_sessions(user_id, started_at desc);
create index if not exists idx_labour_open on labour_sessions(user_id) where ended_at is null;
-- satu orang hanya boleh punya satu sesi terbuka
create unique index if not exists idx_labour_single_open
  on labour_sessions(user_id) where ended_at is null;

create or replace function start_labour(
  p_task_type task_type, p_reference_id uuid default null,
  p_reference_no text default null, p_zone_id uuid default null,
  p_device text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- tutup sesi menggantung lebih dari 12 jam (petugas lupa clock out)
  update labour_sessions
     set ended_at = started_at + interval '8 hours'
   where user_id = auth.uid() and ended_at is null and started_at < now() - interval '12 hours';

  insert into labour_sessions(user_id, task_type, reference_id, reference_no, zone_id, device_id)
  values (auth.uid(), p_task_type, p_reference_id, p_reference_no, p_zone_id, p_device)
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'SESSION_OPEN: masih ada sesi kerja yang belum ditutup';
end;
$$;

create or replace function end_labour(
  p_session_id uuid, p_units numeric default null, p_lines integer default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  update labour_sessions
     set ended_at = now(), units_handled = p_units, lines_handled = p_lines
   where id = p_session_id and user_id = auth.uid() and ended_at is null;
  if not found then raise exception 'SESSION_NOT_FOUND_OR_CLOSED'; end if;
end;
$$;

create or replace view v_labour_kpi as
select ls.user_id, p.full_name, p.role, ls.task_type,
       date_trunc('day', ls.started_at at time zone 'Asia/Jakarta') as day,
       count(*) sessions,
       round(sum(ls.duration_min), 1) total_min,
       sum(ls.lines_handled) total_lines,
       round(sum(ls.units_handled), 2) total_units,
       round(sum(ls.lines_handled)::numeric / nullif(sum(ls.duration_min), 0) * 60, 2) lines_per_hour,
       round(sum(ls.units_handled) / nullif(sum(ls.duration_min), 0) * 60, 2) units_per_hour
from labour_sessions ls
join profiles p on p.id = ls.user_id
where ls.ended_at is not null
group by 1,2,3,4,5;

-- akurasi & kepatuhan per petugas: sumber diskusi coaching, bukan hukuman
create or replace view v_pick_accuracy as
select pll.picked_by user_id, p.full_name,
       date_trunc('week', pll.picked_at) week,
       count(*) lines_picked,
       count(*) filter (where pll.status = 'SHORT') lines_short,
       count(*) filter (where pll.fefo_override) fefo_overrides,
       count(*) filter (where pll.picked_lot_id is distinct from pll.suggested_lot_id) lot_deviations,
       round(count(*) filter (where pll.picked_lot_id = pll.suggested_lot_id)::numeric
             / nullif(count(*), 0) * 100, 2) suggestion_match_pct
from pick_list_lines pll
left join profiles p on p.id = pll.picked_by
where pll.status in ('COMPLETED','SHORT')
group by 1,2,3;

create or replace view v_putaway_productivity as
select t.completed_by user_id, p.full_name,
       date_trunc('day', t.completed_at) as day,
       count(*) tasks_done,
       count(*) filter (where t.actual_location_id is distinct from t.suggested_location_id) deviations,
       round(avg(extract(epoch from (t.completed_at - t.created_at))/60.0), 1) avg_minutes_per_task
from putaway_tasks t
left join profiles p on p.id = t.completed_by
where t.status = 'DONE'
group by 1,2,3;

-- ringkasan gelombang: waktu tempuh dan baris per jam
create or replace view v_wave_performance as
select w.id wave_id, w.wave_no, w.strategy, pr.full_name picker,
       count(distinct pl.batch_id) batches,
       count(pll.id) total_lines,
       count(distinct pll.from_location_id) stops,
       round(extract(epoch from (w.completed_at - w.started_at))/60.0, 1) minutes_taken,
       round(count(pll.id)::numeric
             / nullif(extract(epoch from (w.completed_at - w.started_at))/3600.0, 0), 1) lines_per_hour
from pick_waves w
join pick_lists pl on pl.wave_id = w.id
join pick_list_lines pll on pll.pick_list_id = pl.id
left join profiles pr on pr.id = w.assigned_to
where w.completed_at is not null
group by w.id, w.wave_no, w.strategy, pr.full_name, w.completed_at, w.started_at;

-- =====================================================================
-- BAGIAN 3 — DASBOR PERPUTARAN
-- =====================================================================

-- klasifikasi ABC berdasarkan nilai pemakaian 12 bulan
create or replace function classify_abc()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  with usage as (
    select m.item_id, sum(abs(m.qty) * coalesce(m.unit_cost, 0)) value_used
    from stock_movements m
    where m.type in ('ISSUE','SHIPMENT','PICK')
      and m.moved_at >= now() - interval '365 days'
    group by m.item_id
  ), ranked as (
    select item_id, value_used,
           sum(value_used) over (order by value_used desc) / nullif(sum(value_used) over (), 0) cum_pct
    from usage
  ), assigned as (
    select item_id, case when cum_pct <= 0.80 then 'A'
                         when cum_pct <= 0.95 then 'B' else 'C' end cls
    from ranked
  ), upd as (
    update items i set abc_class = a.cls from assigned a where a.item_id = i.id returning 1
  ) select count(*) into v_n from upd;

  -- item tanpa pemakaian sama sekali
  update items set abc_class = 'C'
   where abc_class is null and is_active
     and not exists (select 1 from stock_movements m where m.item_id = items.id
                     and m.moved_at >= now() - interval '365 days');
  return v_n;
end;
$$;
-- select cron.schedule('neotrace-abc','0 18 1 * *', $$select classify_abc()$$);  -- tiap awal bulan

create or replace view v_inventory_turnover as
with issued as (
  select m.item_id,
         sum(abs(m.qty)) qty_issued,
         sum(abs(m.qty) * coalesce(m.unit_cost, 0)) cogs
  from stock_movements m
  where m.type in ('ISSUE','SHIPMENT','PICK') and m.moved_at >= now() - interval '365 days'
  group by m.item_id
), onhand as (
  select lo.item_id,
         sum(h.qty_remaining) qty_on_hand,
         sum(h.qty_remaining * coalesce(lo.unit_cost, 0)) value_on_hand
  from handling_units h join lots lo on lo.id = h.lot_id
  where h.status = 'ACTIVE'
  group by lo.item_id
)
select i.id item_id, i.code, i.name, i.type, i.abc_class,
       coalesce(s.qty_issued, 0) qty_issued_12m,
       coalesce(o.qty_on_hand, 0) qty_on_hand,
       round(coalesce(o.value_on_hand, 0), 2) value_on_hand,
       round(coalesce(s.cogs, 0) / nullif(o.value_on_hand, 0), 2) turnover_ratio,
       round(365 * nullif(o.value_on_hand, 0) / nullif(s.cogs, 0), 1) days_on_hand
from items i
left join issued s on s.item_id = i.id
left join onhand o on o.item_id = i.id
where i.is_active;

-- barang mati: masih ada stok, tidak dipakai berbulan-bulan
create or replace view v_slow_moving as
select i.code, i.name, i.abc_class,
       sum(h.qty_remaining) qty_on_hand,
       round(sum(h.qty_remaining * coalesce(lo.unit_cost, 0)), 2) value_on_hand,
       max(m.moved_at) last_movement,
       coalesce(date_part('day', now() - max(m.moved_at))::int, 9999) days_since_movement,
       min(lo.expiry_date) nearest_expiry
from items i
join lots lo on lo.item_id = i.id
join handling_units h on h.lot_id = lo.id and h.status = 'ACTIVE' and h.qty_remaining > 0
left join stock_movements m on m.item_id = i.id and m.type in ('ISSUE','SHIPMENT','PICK')
group by i.id, i.code, i.name, i.abc_class
having coalesce(max(m.moved_at), '1900-01-01') < now() - interval '90 days'
order by 5 desc;

create or replace view v_warehouse_utilisation as
select l.type, l.rack_code,
       count(*) location_count,
       round(avg(vl.utilisation_pct), 2) avg_utilisation_pct,
       count(*) filter (where vl.utilisation_pct >= 90) near_full,
       count(*) filter (where coalesce(vl.current_hu_count, 0) = 0) empty_locations,
       round(count(*) filter (where coalesce(vl.current_hu_count,0) > 0)::numeric
             / nullif(count(*), 0) * 100, 2) occupancy_pct
from locations l
left join v_location_load vl on vl.location_id = l.id
where l.is_active and not l.is_staging
group by l.type, l.rack_code;

-- ringkasan harian untuk layar manajemen
create or replace view v_ops_scorecard as
select
  (select count(*) from putaway_tasks where status in ('OPEN','ASSIGNED')) open_putaway,
  (select count(*) from pick_lists where status in ('OPEN','ASSIGNED','IN_PROGRESS')) open_picks,
  (select count(*) from pick_waves where status in ('OPEN','ASSIGNED','IN_PROGRESS')) open_waves,
  (select round(avg(hours_to_stock), 2) from v_dock_to_stock
    where received_at >= now() - interval '30 days') avg_dock_to_stock_hours,
  (select round(avg(compliance_pct), 2) from v_putaway_compliance
    where week >= now() - interval '30 days') putaway_compliance_pct,
  (select round(avg(compliance_pct), 2) from v_fefo_compliance
    where week >= now() - interval '30 days') fefo_compliance_pct,
  (select round(avg(lines_per_hour), 1) from v_wave_performance) avg_wave_lines_per_hour,
  (select count(*) from v_slow_moving) slow_moving_items,
  (select round(sum(value_on_hand), 0) from v_inventory_turnover) total_inventory_value;

-- =====================================================================
-- BAGIAN 4 — RLS
-- =====================================================================
alter table pick_waves      enable row level security;
alter table labour_sessions enable row level security;

create policy p_read_pick_waves on pick_waves for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_wh_waves on pick_waves for all to authenticated
  using (current_role_is('WAREHOUSE','PLANNER','ADMIN'))
  with check (current_role_is('WAREHOUSE','PLANNER','ADMIN'));

-- petugas hanya melihat sesi kerjanya sendiri; supervisor melihat semua
create policy p_labour_self on labour_sessions for select to authenticated
  using (user_id = auth.uid() or current_role_is('ADMIN','PLANNER','QA'));
create policy p_labour_insert on labour_sessions for insert to authenticated
  with check (user_id = auth.uid());
create policy p_labour_update on labour_sessions for update to authenticated
  using (user_id = auth.uid() or current_role_is('ADMIN'));

alter publication supabase_realtime add table pick_waves;

-- =====================================================================
-- BAGIAN 5 — SEED
-- =====================================================================
insert into number_sequences(prefix, period, last_number, padding)
values ('WAV', to_char(now(),'YYMM'), 0, 4)
on conflict do nothing;

comment on view v_labour_kpi is
  'KPI produktivitas per petugas. Gunakan untuk coaching dan perencanaan kapasitas, bukan sebagai dasar sanksi individual — angka ini dipengaruhi tata letak, jenis bahan, dan kondisi shift.';
