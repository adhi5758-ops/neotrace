-- =====================================================================
-- NEOTRACE — Fase 5 delta
-- PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
--
-- Tiga celah traceability yang ditemukan saat audit alur WMS end-to-end
-- (17 Agu 2026): produk jadi tidak pernah dapat handling unit/label/put-away,
-- tidak ada pencatatan scrap bahan baku, dan tidak ada sisi outbound
-- (sales order/DO) sama sekali. Delta ini menutup ketiganya.
--
-- Jalankan SETELAH neotrace_phase4_delta.sql.
-- =====================================================================

-- =====================================================================
-- BAGIAN 1 — DELIVERY ORDER LINES: lot_id jadi opsional
--   Sebelumnya lot_id wajib diisi saat baris dibuat, artinya DO cuma bisa
--   dicatat SETELAH tahu persis lot mana yang dikirim. Itu menutup jalan
--   untuk memesan dulu (item + qty), baru menugaskan lot lewat FEFO saat
--   picking — pola yang sama yang sudah dipakai batch produksi.
--   Baris "pesanan" (belum dipetik) punya lot_id null; ship_delivery_order()
--   di bawah menggantinya dengan baris aktual begitu picking selesai.
-- =====================================================================
alter table delivery_order_lines alter column lot_id drop not null;

-- =====================================================================
-- BAGIAN 2 — SCRAP BAHAN BAKU
--   production_batches.reject_qty cuma mencatat produk jadi yang reject di
--   akhir batch. Tidak ada cara mencatat bahan baku yang rusak/tumpah SAAT
--   produksi berjalan — celah akurasi stok nyata, bukan sekadar kenyamanan.
-- =====================================================================
create table production_scrap (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references production_batches(id),
  item_id       uuid not null references items(id),
  lot_id        uuid not null references lots(id),
  hu_id         uuid references handling_units(id),
  qty           numeric(18,3) not null check (qty > 0),
  uom           text not null,
  reason        text not null check (length(trim(reason)) >= 8),
  logged_by     uuid references profiles(id),
  logged_at     timestamptz not null default now()
);
create index idx_scrap_batch on production_scrap(batch_id);

-- catat scrap: kurangi qty_remaining HU lewat stock_movements (bukan update
-- langsung) supaya tetap lewat buku besar yang sama dengan semua pergerakan
-- lain, lalu tandai SCRAPPED spesifik (bukan cuma EMPTY generik dari trigger)
-- supaya jelas kenapa HU itu kosong saat ditelusuri nanti.
create or replace function log_scrap(
  p_batch_id uuid, p_hu_id uuid, p_qty numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare h record; v_id uuid;
begin
  if length(trim(p_reason)) < 8 then
    raise exception 'REASON_REQUIRED: alasan scrap wajib diisi, minimal 8 karakter';
  end if;

  select hu.id, hu.lot_id, hu.qty_remaining, hu.uom, hu.location_id, lo.item_id
    into h
  from handling_units hu join lots lo on lo.id = hu.lot_id
  where hu.id = p_hu_id;
  if not found then raise exception 'HU_NOT_FOUND'; end if;
  if p_qty > h.qty_remaining then
    raise exception 'QTY_EXCEEDS_REMAINING: sisa kemasan cuma % %', h.qty_remaining, h.uom;
  end if;

  insert into production_scrap(batch_id, item_id, lot_id, hu_id, qty, uom, reason, logged_by)
  values (p_batch_id, h.item_id, h.lot_id, p_hu_id, p_qty, h.uom, trim(p_reason), auth.uid())
  returning id into v_id;

  insert into stock_movements(type, item_id, lot_id, hu_id, qty, uom,
                              from_location_id, doc_type, doc_id)
  values ('SCRAP', h.item_id, h.lot_id, p_hu_id, -abs(p_qty), h.uom,
          h.location_id, 'SCRAP', v_id);

  update handling_units set status = 'SCRAPPED'::hu_status
   where id = p_hu_id and qty_remaining <= 0;

  return v_id;
end;
$$;

alter table production_scrap enable row level security;
create policy p_read_production_scrap on production_scrap for select to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and is_active));
create policy p_op_write_scrap on production_scrap for insert to authenticated
  with check (current_role_is('OPERATOR','WAREHOUSE','ADMIN'));

-- =====================================================================
-- BAGIAN 3 — PICK LIST DARI DELIVERY ORDER (outbound)
--   Cermin generate_pick_list_from_batch: sumber baris permintaan adalah
--   delivery_order_lines (item + qty pesanan), bukan formula_lines.
-- =====================================================================
create or replace function generate_pick_list_from_do(p_do_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_pick uuid; r record; s record;
begin
  if not exists (select 1 from delivery_orders where id = p_do_id) then
    raise exception 'DO_NOT_FOUND';
  end if;
  if exists (select 1 from pick_lists where do_id = p_do_id and status <> 'CANCELLED') then
    raise exception 'PICK_LIST_EXISTS: DO ini sudah punya picking list aktif';
  end if;

  insert into pick_lists(doc_no, source_type, do_id, created_by)
  values (next_doc_no('PCK'), 'DO', p_do_id, auth.uid())
  returning id into v_pick;

  for r in
    select item_id, uom, qty qty_needed
    from delivery_order_lines
    where do_id = p_do_id
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
    raise exception 'NO_STOCK: tidak ada lot RELEASED yang siap kirim untuk pesanan ini';
  end if;

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

-- =====================================================================
-- BAGIAN 4 — KIRIM: kunci DO setelah picking selesai
--   qty_remaining HU sudah berkurang saat confirm_pick (movement 'PICK') —
--   itu sudah jadi jejak buku besar kuantitas yang sah. Di sini TIDAK ada
--   movement kedua: dicoba dulu SHIPMENT qty=0 murni sebagai jejak
--   dokumen (pola yang dikira sama dengan TRANSFER di complete_putaway),
--   ternyata beda — chk_qty_nonzero cuma mengizinkan qty=0 untuk
--   type='TRANSFER', bukan sembarang tipe (ditemukan live saat uji coba
--   pertama fitur ini, 17 Agu 2026). delivery_order_lines + status
--   HU='SHIPPED' sudah cukup jadi jejak pengiriman tanpa movement kedua.
-- =====================================================================
create or replace function ship_delivery_order(
  p_do_id uuid, p_transporter_id uuid default null,
  p_vehicle_no text default null, p_driver_name text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_pick record; r record;
begin
  select * into v_pick from pick_lists where do_id = p_do_id and source_type = 'DO' and status <> 'CANCELLED';
  if not found then raise exception 'PICK_LIST_NOT_FOUND: terbitkan dan selesaikan pick list dulu'; end if;
  if v_pick.status <> 'COMPLETED' then
    raise exception 'PICK_NOT_DONE: picking belum selesai (status %)', v_pick.status;
  end if;

  delete from delivery_order_lines where do_id = p_do_id and lot_id is null;

  for r in
    select pll.item_id, pll.picked_lot_id, pll.picked_hu_id, pll.qty_picked, pll.uom
    from pick_list_lines pll
    where pll.pick_list_id = v_pick.id and pll.status in ('COMPLETED','SHORT') and pll.picked_lot_id is not null
  loop
    insert into delivery_order_lines(do_id, item_id, lot_id, hu_id, qty, uom)
    values (p_do_id, r.item_id, r.picked_lot_id, r.picked_hu_id, r.qty_picked, r.uom);

    update handling_units set status = 'SHIPPED'::hu_status where id = r.picked_hu_id;
  end loop;

  if not exists (select 1 from delivery_order_lines where do_id = p_do_id) then
    raise exception 'NOTHING_PICKED: tidak ada baris terpetik untuk dikirim';
  end if;

  update delivery_orders
     set status = 'POSTED', shipped_at = now(), shipped_by = auth.uid(),
         transporter_id = coalesce(p_transporter_id, transporter_id),
         vehicle_no = coalesce(p_vehicle_no, vehicle_no),
         driver_name = coalesce(p_driver_name, driver_name)
   where id = p_do_id;
end;
$$;

-- =====================================================================
-- BAGIAN 5 — PRODUK JADI: handling unit + put-away (ditutup di api.ts,
--   closeBatch() sekarang membuat HU dan memanggil create_putaway_tasks()
--   lewat RPC yang sudah ada di phase2 — tidak perlu fungsi baru di sini).
-- =====================================================================
