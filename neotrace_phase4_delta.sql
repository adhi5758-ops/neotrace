-- =====================================================================
-- NEOTRACE — FASE 4 (delta di atas v1 + Fase 1 + 2 + 3)
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- CAKUPAN FASE 4
--   1. Integrasi ERP  : pola outbox/inbox, pemetaan ID, idempotensi, retry
--   2. Forecasting    : riwayat konsumsi, musiman, peramalan, reorder point
--
-- CATATAN ARSITEKTUR
--   NEOTRACE tetap sistem pencatat kejadian lantai (system of record untuk
--   lot, batch, dan pergerakan fisik). ERP tetap system of record untuk
--   akuntansi, pembelian, dan penjualan. Arah data ditentukan per entitas
--   di tabel integration_endpoints — jangan biarkan dua sistem sama-sama
--   merasa memiliki data yang sama.
--
-- PRASYARAT: v1 + delta Fase 1, 2, dan 3.
-- =====================================================================

-- =====================================================================
-- BAGIAN 1 — INTEGRASI ERP
-- =====================================================================
create type sync_direction as enum ('OUTBOUND','INBOUND','BIDIRECTIONAL');
create type sync_status    as enum ('PENDING','CLAIMED','SENT','ACKED','FAILED','DEAD','SKIPPED');
create type sync_operation as enum ('CREATE','UPDATE','CANCEL','UPSERT');

create table integration_endpoints (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,               -- NETSUITE_PROD, NETSUITE_SB
  name          text not null,
  base_url      text,
  direction     sync_direction not null,
  entity_types  text[] not null,                    -- {'GRN','DO','BATCH','ADJUSTMENT','ITEM'}
  is_active     boolean not null default true,
  max_attempts  smallint not null default 6,
  config        jsonb not null default '{}',        -- account id, script id, deploy id
  last_success_at timestamptz,
  last_error_at   timestamptz,
  last_error      text,
  created_at    timestamptz not null default now()
);

/**
 * Pemetaan ID lokal ke ID di sistem eksternal. Tanpa ini, setiap retry
 * berisiko membuat dokumen ganda di ERP.
 */
create table entity_mappings (
  id            uuid primary key default gen_random_uuid(),
  endpoint_id   uuid not null references integration_endpoints(id) on delete cascade,
  entity_type   text not null,                      -- ITEM, PARTNER, LOCATION, GRN, DO
  local_id      uuid not null,
  external_id   text not null,
  external_ref  text,                               -- nomor dokumen di ERP
  synced_at     timestamptz not null default now(),
  unique (endpoint_id, entity_type, local_id),
  unique (endpoint_id, entity_type, external_id)
);
create index if not exists idx_map_lookup on entity_mappings(entity_type, local_id);

create table sync_outbox (
  id              bigserial primary key,
  endpoint_id     uuid not null references integration_endpoints(id),
  entity_type     text not null,
  entity_id       uuid not null,
  operation       sync_operation not null default 'CREATE',
  idempotency_key text not null,                    -- cegah dokumen ganda saat retry
  payload         jsonb not null,
  status          sync_status not null default 'PENDING',
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  claimed_by      text,                             -- id worker
  sent_at         timestamptz,
  acked_at        timestamptz,
  external_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (endpoint_id, idempotency_key)
);
create index if not exists idx_outbox_ready
  on sync_outbox(next_attempt_at) where status in ('PENDING','FAILED');
create index if not exists idx_outbox_entity on sync_outbox(entity_type, entity_id);

create table sync_inbox (
  id            bigserial primary key,
  endpoint_id   uuid not null references integration_endpoints(id),
  entity_type   text not null,
  external_id   text not null,
  operation     sync_operation not null default 'UPSERT',
  payload       jsonb not null,
  status        sync_status not null default 'PENDING',
  processed_at  timestamptz,
  local_id      uuid,
  last_error    text,
  received_at   timestamptz not null default now(),
  unique (endpoint_id, entity_type, external_id, received_at)
);
create index if not exists idx_inbox_pending on sync_inbox(status) where status = 'PENDING';

create table sync_log (
  id           bigserial primary key,
  outbox_id    bigint references sync_outbox(id) on delete cascade,
  inbox_id     bigint references sync_inbox(id) on delete cascade,
  attempt      smallint,
  http_status  integer,
  request_body jsonb,
  response_body jsonb,
  duration_ms  integer,
  logged_at    timestamptz not null default now()
);
create index if not exists idx_synclog_outbox on sync_log(outbox_id);

/* ---------------------------------------------------- pembentuk payload */

create or replace function build_grn_payload(p_receipt_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'docNo', gr.doc_no,
    'receivedAt', gr.received_at,
    'supplier', jsonb_build_object('localId', p.id, 'code', p.code, 'name', p.name),
    'poNo', gr.po_no,
    'supplierDoNo', gr.supplier_do_no,
    'lines', coalesce(jsonb_agg(jsonb_build_object(
        'itemLocalId', i.id, 'itemCode', i.code,
        'lotCode', lo.lot_code,
        'qty', grl.qty_received, 'uom', grl.uom,
        'unitPrice', grl.unit_price,
        'expiryDate', lo.expiry_date,
        'ownerType', lo.owner_type
      ) order by grl.id), '[]'::jsonb)
  )
  from goods_receipts gr
  join partners p on p.id = gr.supplier_id
  left join goods_receipt_lines grl on grl.receipt_id = gr.id
  left join items i on i.id = grl.item_id
  left join lots lo on lo.id = grl.lot_id
  where gr.id = p_receipt_id
  group by gr.id, p.id;
$$;

create or replace function build_do_payload(p_do_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'docNo', d.doc_no,
    'shippedAt', d.shipped_at,
    'customer', jsonb_build_object('localId', c.id, 'code', c.code, 'name', c.name),
    'soNo', d.so_no,
    'lines', coalesce(jsonb_agg(jsonb_build_object(
        'itemLocalId', i.id, 'itemCode', i.code,
        'lotCode', lo.lot_code,
        'qty', dol.qty, 'uom', dol.uom, 'unitPrice', dol.unit_price
      ) order by dol.id), '[]'::jsonb)
  )
  from delivery_orders d
  join partners c on c.id = d.customer_id
  left join delivery_order_lines dol on dol.do_id = d.id
  left join items i on i.id = dol.item_id
  left join lots lo on lo.id = dol.lot_id
  where d.id = p_do_id
  group by d.id, c.id;
$$;

create or replace function build_batch_payload(p_batch_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'batchNo', pb.batch_no,
    'product', jsonb_build_object('localId', i.id, 'code', i.code),
    'outputQty', pb.actual_qty, 'rejectQty', pb.reject_qty,
    'outputLot', lo.lot_code,
    'closedAt', pb.closed_at,
    'yieldPct', pb.yield_pct,
    'actualCostPerUom', bc.actual_cost_per_uom,
    'materialCost', bc.material_cost,
    'otherCost', bc.other_cost,
    'consumption', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemLocalId', ci.id, 'itemCode', ci.code,
        'lotCode', cl.lot_code, 'qty', c.qty_actual,
        'uom', c.uom, 'unitCost', c.unit_cost))
      from batch_consumption c
      join items ci on ci.id = c.item_id
      join lots cl on cl.id = c.lot_id
      where c.batch_id = pb.id), '[]'::jsonb)
  )
  from production_batches pb
  join items i on i.id = pb.item_id
  left join lots lo on lo.id = pb.output_lot_id
  left join v_batch_cost bc on bc.batch_id = pb.id
  where pb.id = p_batch_id;
$$;

/* ------------------------------------------------------ antre ke outbox */

create or replace function enqueue_sync(
  p_entity_type text, p_entity_id uuid, p_operation sync_operation default 'CREATE'
) returns integer language plpgsql security definer set search_path = public as $$
declare e record; v_payload jsonb; v_key text; v_n int := 0;
begin
  v_payload := case p_entity_type
    when 'GRN'   then build_grn_payload(p_entity_id)
    when 'DO'    then build_do_payload(p_entity_id)
    when 'BATCH' then build_batch_payload(p_entity_id)
    else null end;
  if v_payload is null then return 0; end if;

  for e in select * from integration_endpoints
            where is_active and direction in ('OUTBOUND','BIDIRECTIONAL')
              and p_entity_type = any(entity_types)
  loop
    v_key := p_entity_type || ':' || p_entity_id || ':' || p_operation;
    insert into sync_outbox(endpoint_id, entity_type, entity_id, operation, idempotency_key, payload)
    values (e.id, p_entity_type, p_entity_id, p_operation, v_key, v_payload)
    on conflict (endpoint_id, idempotency_key) do update
      set payload = excluded.payload,
          status = case when sync_outbox.status in ('ACKED','SENT') then sync_outbox.status else 'PENDING' end;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- pemicu otomatis pada kejadian yang perlu dikirim ke ERP
create or replace function trg_enqueue_grn() returns trigger language plpgsql as $$
begin
  if new.status = 'POSTED' and coalesce(old.status, 'DRAFT') <> 'POSTED' then
    perform enqueue_sync('GRN', new.id, 'CREATE');
  end if;
  return new;
end; $$;
create trigger t_sync_grn after update of status on goods_receipts
  for each row execute function trg_enqueue_grn();

create or replace function trg_enqueue_do() returns trigger language plpgsql as $$
begin
  if new.status = 'POSTED' and coalesce(old.status, 'DRAFT') <> 'POSTED' then
    perform enqueue_sync('DO', new.id, 'CREATE');
  end if;
  return new;
end; $$;
create trigger t_sync_do after update of status on delivery_orders
  for each row execute function trg_enqueue_do();

create or replace function trg_enqueue_batch() returns trigger language plpgsql as $$
begin
  if new.status = 'CLOSED' and coalesce(old.status::text, '') <> 'CLOSED' then
    perform enqueue_sync('BATCH', new.id, 'CREATE');
  end if;
  return new;
end; $$;
create trigger t_sync_batch after update of status on production_batches
  for each row execute function trg_enqueue_batch();

/* --------------------------------------------------------- sisi worker */

/** Worker mengambil sejumlah pesan siap kirim dan menguncinya. */
create or replace function claim_outbox(p_worker text, p_limit integer default 20)
returns setof sync_outbox language plpgsql security definer set search_path = public as $$
begin
  return query
  update sync_outbox o
     set status = 'CLAIMED', claimed_at = now(), claimed_by = p_worker
   where o.id in (
     select id from sync_outbox
      where status in ('PENDING','FAILED') and next_attempt_at <= now()
      order by created_at
      limit p_limit
      for update skip locked
   )
  returning o.*;
end;
$$;

/** Tandai sukses dan simpan ID eksternal untuk pemetaan. */
create or replace function ack_outbox(p_id bigint, p_external_id text)
returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  update sync_outbox
     set status = 'ACKED', acked_at = now(), sent_at = coalesce(sent_at, now()),
         external_id = p_external_id, last_error = null
   where id = p_id
  returning * into o;

  if o.entity_id is not null and p_external_id is not null then
    insert into entity_mappings(endpoint_id, entity_type, local_id, external_id)
    values (o.endpoint_id, o.entity_type, o.entity_id, p_external_id)
    on conflict (endpoint_id, entity_type, local_id) do update
      set external_id = excluded.external_id, synced_at = now();
  end if;

  update integration_endpoints set last_success_at = now() where id = o.endpoint_id;
end;
$$;

/** Gagal: mundur eksponensial, mati setelah max_attempts dan memicu notifikasi. */
create or replace function fail_outbox(p_id bigint, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare o record; v_max smallint;
begin
  select * into o from sync_outbox where id = p_id;
  select max_attempts into v_max from integration_endpoints where id = o.endpoint_id;

  if o.attempts + 1 >= coalesce(v_max, 6) then
    update sync_outbox set status = 'DEAD', attempts = attempts + 1, last_error = p_error where id = p_id;
    insert into notifications(type, severity, title, body, target_role)
    values ('QC_PENDING', 'CRITICAL',
            'Sinkronisasi ERP gagal permanen',
            format('%s %s gagal setelah %s percobaan: %s', o.entity_type, o.entity_id, o.attempts + 1, p_error),
            'ADMIN');
  else
    update sync_outbox
       set status = 'FAILED', attempts = attempts + 1, last_error = p_error,
           next_attempt_at = now() + (interval '1 minute' * power(3, attempts + 1)),
           claimed_at = null, claimed_by = null
     where id = p_id;
  end if;

  update integration_endpoints set last_error_at = now(), last_error = p_error where id = o.endpoint_id;
end;
$$;

-- lepas klaim yang menggantung (worker mati di tengah jalan)
create or replace function reclaim_stuck_outbox()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with upd as (
    update sync_outbox set status = 'PENDING', claimed_at = null, claimed_by = null
     where status = 'CLAIMED' and claimed_at < now() - interval '15 minutes'
    returning 1
  ) select count(*) into v_n from upd;
  return v_n;
end;
$$;
-- select cron.schedule('neotrace-reclaim','*/10 * * * *', $$select reclaim_stuck_outbox()$$);

create or replace view v_sync_health as
select e.code endpoint, e.direction,
       count(*) filter (where o.status = 'PENDING') pending,
       count(*) filter (where o.status = 'FAILED')  failed,
       count(*) filter (where o.status = 'DEAD')    dead,
       count(*) filter (where o.status = 'ACKED' and o.acked_at >= now() - interval '24 hours') acked_24h,
       max(o.acked_at) last_ack,
       e.last_error_at, e.last_error
from integration_endpoints e
left join sync_outbox o on o.endpoint_id = e.id
group by e.id, e.code, e.direction, e.last_error_at, e.last_error;

-- =====================================================================
-- BAGIAN 2 — FORECASTING
-- =====================================================================

-- riwayat konsumsi bulanan: input model, sekaligus dasar reorder point
create or replace view v_consumption_history as
select bc.item_id, i.code item_code, i.name item_name,
       date_trunc('month', bc.consumed_at at time zone 'Asia/Jakarta')::date period,
       sum(bc.qty_actual) qty_consumed,
       count(distinct bc.batch_id) batch_count,
       round(avg(bc.unit_cost), 2) avg_unit_cost
from batch_consumption bc
join items i on i.id = bc.item_id
group by 1,2,3,4;

-- pola musiman sederhana: indeks bulan terhadap rata-rata tahunan
create or replace view v_seasonality as
with monthly as (
  select item_id, extract(month from period) mth, avg(qty_consumed) avg_qty
  from v_consumption_history group by 1,2
), overall as (
  select item_id, avg(avg_qty) base from monthly group by 1
)
select m.item_id, m.mth::int month_no,
       round(m.avg_qty, 2) avg_qty,
       round(m.avg_qty / nullif(o.base, 0), 3) seasonal_index
from monthly m join overall o on o.item_id = m.item_id;

create table demand_forecasts (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  forecast_qty    numeric(18,3) not null,
  confidence_low  numeric(18,3),
  confidence_high numeric(18,3),
  method          text not null,                    -- MOVING_AVG, HOLT_WINTERS, MANUAL
  actual_qty      numeric(18,3),                    -- diisi setelah periode lewat
  abs_error       numeric(18,3) generated always as (
    case when actual_qty is not null then abs(actual_qty - forecast_qty) end) stored,
  generated_at    timestamptz not null default now(),
  generated_by    uuid references profiles(id),
  notes           text,
  unique (item_id, period_start, period_end, method)
);
create index if not exists idx_forecast_item on demand_forecasts(item_id, period_start);

/** Peramalan sederhana di database: rata-rata bergerak 3 bulan × indeks musiman.
    Model yang lebih baik dijalankan di luar dan hasilnya ditulis ke tabel ini. */
create or replace function forecast_moving_average(p_months integer default 3)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n int := 0; v_start date; v_end date; v_month int;
begin
  v_start := date_trunc('month', now() + interval '1 month')::date;
  v_end   := (v_start + interval '1 month - 1 day')::date;
  v_month := extract(month from v_start);

  with base as (
    select h.item_id, avg(h.qty_consumed) avg_qty, stddev_samp(h.qty_consumed) sd
    from v_consumption_history h
    where h.period >= date_trunc('month', now() - (p_months || ' months')::interval)::date
      and h.period <  date_trunc('month', now())::date
    group by h.item_id
    having count(*) >= 2
  ), fc as (
    select b.item_id,
           round(b.avg_qty * coalesce(s.seasonal_index, 1), 3) qty,
           round(greatest(b.avg_qty * coalesce(s.seasonal_index, 1) - coalesce(b.sd, 0), 0), 3) lo,
           round(b.avg_qty * coalesce(s.seasonal_index, 1) + coalesce(b.sd, 0), 3) hi
    from base b
    left join v_seasonality s on s.item_id = b.item_id and s.month_no = v_month
  ), ins as (
    insert into demand_forecasts(item_id, period_start, period_end, forecast_qty,
                                 confidence_low, confidence_high, method)
    select item_id, v_start, v_end, qty, lo, hi, 'MOVING_AVG' from fc
    on conflict (item_id, period_start, period_end, method) do update
      set forecast_qty = excluded.forecast_qty,
          confidence_low = excluded.confidence_low,
          confidence_high = excluded.confidence_high,
          generated_at = now()
    returning 1
  ) select count(*) into v_n from ins;
  return v_n;
end;
$$;
-- select cron.schedule('neotrace-forecast','0 18 25 * *', $$select forecast_moving_average(3)$$);

-- isi realisasi agar akurasi bisa diukur
create or replace function backfill_forecast_actuals()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  with upd as (
    update demand_forecasts f
       set actual_qty = h.qty_consumed
      from v_consumption_history h
     where h.item_id = f.item_id and h.period = f.period_start
       and f.actual_qty is null and f.period_end < current_date
    returning 1
  ) select count(*) into v_n from upd;
  return v_n;
end;
$$;

create or replace view v_forecast_accuracy as
select f.method, i.code item_code, i.name item_name, i.abc_class,
       count(*) periods,
       round(avg(f.abs_error), 2) mae,
       round(avg(f.abs_error / nullif(f.actual_qty, 0)) * 100, 2) mape_pct,
       round(avg(f.forecast_qty - f.actual_qty), 2) bias
from demand_forecasts f
join items i on i.id = f.item_id
where f.actual_qty is not null
group by 1,2,3,4;

-- titik pemesanan ulang
create table reorder_points (
  item_id           uuid primary key references items(id) on delete cascade,
  lead_time_days    smallint not null default 7,
  safety_stock_qty  numeric(18,3),
  reorder_qty       numeric(18,3),
  min_order_qty     numeric(18,3),
  review_period_days smallint not null default 7,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references profiles(id)
);

create or replace view v_reorder_suggestions as
with onhand as (
  select lo.item_id, sum(h.qty_remaining) qty
  from handling_units h join lots lo on lo.id = h.lot_id
  where h.status = 'ACTIVE' and lo.status = 'RELEASED'
    and (lo.expiry_date is null or lo.expiry_date >= current_date)
  group by lo.item_id
), fc as (
  select item_id, forecast_qty from demand_forecasts f
  where f.period_start = date_trunc('month', now() + interval '1 month')::date
    and f.method = 'MOVING_AVG'
)
select i.code, i.name, i.abc_class,
       coalesce(o.qty, 0) qty_on_hand,
       coalesce(f.forecast_qty, 0) forecast_next_month,
       rp.lead_time_days, rp.safety_stock_qty,
       round(coalesce(f.forecast_qty, 0) / 30.0 * rp.lead_time_days
             + coalesce(rp.safety_stock_qty, 0), 2) reorder_level,
       case when coalesce(o.qty, 0) <=
                 (coalesce(f.forecast_qty, 0) / 30.0 * rp.lead_time_days
                  + coalesce(rp.safety_stock_qty, 0))
            then true else false end needs_reorder,
       round(coalesce(o.qty, 0) / nullif(coalesce(f.forecast_qty, 0) / 30.0, 0), 1) days_of_cover
from items i
join reorder_points rp on rp.item_id = i.id
left join onhand o on o.item_id = i.id
left join fc f on f.item_id = i.id
where i.is_active;

-- =====================================================================
-- BAGIAN 3 — RLS
-- =====================================================================
alter table integration_endpoints enable row level security;
alter table entity_mappings       enable row level security;
alter table sync_outbox           enable row level security;
alter table sync_inbox            enable row level security;
alter table sync_log              enable row level security;
alter table demand_forecasts      enable row level security;
alter table reorder_points        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['entity_mappings','sync_outbox','sync_inbox','sync_log',
                           'demand_forecasts','reorder_points'] loop
    execute format(
      'create policy p_read_%1$s on %1$I for select to authenticated using (
         current_role_is(''ADMIN'',''PLANNER'',''FINANCE''))', t);
  end loop;
end $$;

create policy p_read_endpoints on integration_endpoints for select to authenticated
  using (current_role_is('ADMIN'));
create policy p_admin_endpoints on integration_endpoints for all to authenticated
  using (current_role_is('ADMIN')) with check (current_role_is('ADMIN'));
create policy p_planner_forecast on demand_forecasts for all to authenticated
  using (current_role_is('PLANNER','ADMIN')) with check (current_role_is('PLANNER','ADMIN'));
create policy p_planner_reorder on reorder_points for all to authenticated
  using (current_role_is('PLANNER','ADMIN')) with check (current_role_is('PLANNER','ADMIN'));

alter publication supabase_realtime add table sync_outbox;

-- =====================================================================
-- BAGIAN 4 — CATATAN
-- =====================================================================
comment on table sync_outbox is
  'Antrean keluar ke ERP. Idempotency_key mencegah dokumen ganda saat retry — jangan pernah kirim tanpa memeriksanya.';
comment on table integration_endpoints is
  'Arah data per entitas. Tetapkan satu pemilik data untuk tiap entitas: NEOTRACE untuk lot/batch/pergerakan fisik, ERP untuk akuntansi/pembelian/penjualan.';
comment on function forecast_moving_average is
  'Peramalan dasar. Butuh minimal 12-18 bulan data konsumsi bersih agar bermakna. Sebelum itu, gunakan metode MANUAL dan perlakukan hasilnya sebagai indikasi, bukan angka perencanaan.';
