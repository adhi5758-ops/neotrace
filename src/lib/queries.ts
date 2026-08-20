/**
 * NEOTRACE — kueri baca untuk layar.
 *
 * api.ts memegang aksi yang mengubah data (dan penerjemahan errornya).
 * File ini hanya baca: daftar master, antrean kerja, telusur.
 */
import { supabase } from './api';

async function rows<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as T[];
}

/* --------------------------------------------------------------- master */

export interface Item {
  id: string; code: string; name: string; type: string;
  base_uom: string; shelf_life_days: number | null; standard_cost: number | null;
}
export const listItems = (type?: string) =>
  rows<Item>(
    (type
      ? supabase.from('items').select('id, code, name, type, base_uom, shelf_life_days, standard_cost').eq('type', type)
      : supabase.from('items').select('id, code, name, type, base_uom, shelf_life_days, standard_cost')
    ).order('code')
  );

export interface Partner { id: string; code: string; name: string; type: string }
/** partner_type punya nilai 'BOTH' — mitra yang jadi supplier sekaligus klien harus ikut terjaring. */
export const listPartners = (type: 'SUPPLIER' | 'CUSTOMER') =>
  rows<Partner>(supabase.from('partners').select('id, code, name, type').in('type', [type, 'BOTH']).order('name'));

export interface Location { id: string; code: string; name: string | null; type: string; is_staging: boolean; is_primary_pick: boolean }
export const listLocations = () =>
  rows<Location>(supabase.from('locations').select('id, code, name, type, is_staging, is_primary_pick').order('code'));

export interface Allergen { id: number; code: string; name_id: string }
export const listAllergens = () =>
  rows<Allergen>(supabase.from('allergens').select('id, code, name_id').order('code'));

/* ------------------------------------------------------------------- QC */

export interface QcPendingRow {
  lot_id: string; lot_code: string; item_name: string; supplier_name: string | null;
  received_at: string; status: string;
  total_tests: number; pending_tests: number; failed_tests: number; hours_on_hold: number;
}

export interface QcTest {
  id: string; test_type: string; parameter: string; method: string | null;
  is_mandatory: boolean; spec_min: number | null; spec_max: number | null; spec_text: string | null;
  result_num: number | null; result_text: string | null; result: string; lab_name: string | null;
}

export interface QcSample {
  id: string; sample_no: string; type: string; qty: number | null; uom: string | null;
  taken_at: string; qc_tests: QcTest[];
}

export const lotSamples = (lotId: string) =>
  rows<QcSample>(
    supabase
      .from('qc_samples')
      .select('id, sample_no, type, qty, uom, taken_at, qc_tests(id, test_type, parameter, method, is_mandatory, spec_min, spec_max, spec_text, result_num, result_text, result, lab_name)')
      .eq('lot_id', lotId)
      .order('taken_at', { ascending: false })
  );

/** Tambah baris uji ke sampel. Trigger database yang memutuskan PASS/FAIL. */
export async function addTest(sampleId: string, t: {
  test_type: string; parameter: string; is_mandatory: boolean;
  spec_min?: number | null; spec_max?: number | null; spec_text?: string | null;
}) {
  const { error } = await supabase.from('qc_tests').insert({ sample_id: sampleId, ...t });
  if (error) throw error;
}

/* ------------------------------------------------------------- produksi */

export interface Batch {
  id: string; batch_no: string; status: string; qc_result: string | null;
  target_qty: number; actual_qty: number | null; formula_id: string | null;
  started_at: string | null; item_id: string;
  items: { code: string; name: string; base_uom: string; shelf_life_days: number | null } | null;
}

export const listBatches = (open = true) =>
  rows<Batch>(
    supabase
      .from('production_batches')
      .select('id, batch_no, status, qc_result, target_qty, actual_qty, formula_id, started_at, item_id, items(code, name, base_uom, shelf_life_days)')
      .in('status', open ? ['PLANNED', 'RUNNING', 'QC_HOLD'] : ['CLOSED'])
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(50)
  );

export interface FormulaLine {
  id: string; item_id: string; qty: number; uom: string; scrap_pct: number | null;
  sequence: number; items: { code: string; name: string } | null;
}

/** Kebutuhan bahan batch = baris formula diskalakan ke target qty batch. */
export async function batchRequirements(batch: Batch): Promise<
  { itemId: string; itemName: string; qtyNeeded: number; uom: string }[]
> {
  if (!batch.formula_id) return [];
  const { data: formula, error: e1 } = await supabase
    .from('formulas').select('id, output_qty').eq('id', batch.formula_id).single();
  if (e1) throw e1;

  const lines = await rows<FormulaLine>(
    supabase.from('formula_lines')
      .select('id, item_id, qty, uom, scrap_pct, sequence, items(code, name)')
      .eq('formula_id', batch.formula_id)
      .order('sequence')
  );

  const outputQty = (formula as { output_qty: number }).output_qty || 1;
  const scale = batch.target_qty / outputQty;
  return lines.map((l) => ({
    itemId: l.item_id,
    itemName: l.items?.name ?? l.item_id,
    qtyNeeded: +(l.qty * scale * (1 + (l.scrap_pct ?? 0) / 100)).toFixed(3),
    uom: l.uom,
  }));
}

export interface Formula {
  id: string; item_id: string; version: number; output_qty: number; std_yield_pct: number;
}
/** Formula aktif untuk satu SKU produk jadi — dipakai form pembuatan batch. */
export const listFormulas = (itemId: string) =>
  rows<Formula>(
    supabase.from('formulas')
      .select('id, item_id, version, output_qty, std_yield_pct')
      .eq('item_id', itemId)
      .eq('is_active', true)
      .order('version', { ascending: false })
  );

export interface CcpDefinition {
  id: string; code: string; name: string; parameter: string;
  min_value: number | null; max_value: number | null; uom: string | null; is_critical: boolean;
}
/** item_id null di ccp_definitions berarti berlaku untuk semua SKU — harus ikut terambil. */
export const ccpDefinitions = (itemId: string) =>
  rows<CcpDefinition>(
    supabase.from('ccp_definitions')
      .select('id, code, name, parameter, min_value, max_value, uom, is_critical')
      .or(`item_id.eq.${itemId},item_id.is.null`)
      .eq('is_active', true)
      .order('code')
  );

/* --------------------------------------------------------- outbound (DO) */

export interface DeliveryOrderLine {
  id: string; item_id: string; qty: number; uom: string;
  lot_id: string | null; items: { code: string; name: string } | null;
  lots: { lot_code: string } | null;
}
export interface DeliveryOrder {
  id: string; doc_no: string; so_no: string | null; status: string;
  shipped_at: string | null; ship_to_address: string | null;
  vehicle_no: string | null; driver_name: string | null; created_at: string;
  partners: { name: string } | null;
  delivery_order_lines: DeliveryOrderLine[];
}

/**
 * partners!delivery_orders_customer_id_fkey wajib eksplisit — delivery_orders
 * punya DUA FK ke partners (customer_id, transporter_id); pola yang sama
 * seperti lots→partners (supplier_id/owner_partner_id) yang ditemukan
 * sebelumnya, PostgREST menolak menebak arah yang mana.
 */
export const listDeliveryOrders = () =>
  rows<DeliveryOrder>(
    supabase.from('delivery_orders')
      .select(`id, doc_no, so_no, status, shipped_at, ship_to_address, vehicle_no, driver_name, created_at,
        partners!delivery_orders_customer_id_fkey(name),
        delivery_order_lines(id, item_id, qty, uom, lot_id, items(code, name), lots(lot_code))`)
      .order('created_at', { ascending: false })
      .limit(100)
  );

/* -------------------------------------------------------------- telusur */

export interface LotRow {
  id: string; lot_code: string; status: string; expiry_date: string | null;
  halal_valid_until: string | null; owner_type: string; unit_cost: number | null;
  qty_received: number; items: { code: string; name: string; base_uom: string } | null;
  partners: { name: string } | null;
}

/**
 * Cari lot berdasarkan kode lot atau nama/kode bahan.
 *
 * PostgREST tidak bisa meng-OR-kan kolom lokal dengan kolom tabel terkait
 * (items.*) dalam satu string or() datar — dicoba dulu seperti itu, gagal
 * live dengan "failed to parse logic tree" karena hasilnya jadi tanda
 * kurung ganda yang tidak valid. Jalan keluarnya: dua query terpisah (satu
 * atas lot_code, satu atas items.name/items.code lewat opsi referencedTable
 * yang memang didukung), lalu digabung & di-dedup di klien.
 */
export const searchLots = async (q: string): Promise<LotRow[]> => {
  const like = `%${q}%`;
  const base = () =>
    supabase
      .from('lots')
      // partners!lots_supplier_id_fkey wajib eksplisit — lots punya DUA FK ke
      // partners (supplier_id, owner_partner_id), PostgREST menolak menebak
      // (ditemukan live, tersembunyi sebelumnya oleh bug or() di atas)
      .select('id, lot_code, status, expiry_date, halal_valid_until, owner_type, unit_cost, qty_received, items!inner(code, name, base_uom), partners!lots_supplier_id_fkey(name)')
      .order('lot_code')
      .limit(40);

  const [byLot, byItem] = await Promise.all([
    rows<LotRow>(base().ilike('lot_code', like)),
    rows<LotRow>(base().or(`name.ilike.${like},code.ilike.${like}`, { referencedTable: 'items' })),
  ]);

  const merged = new Map(byLot.map((l) => [l.id, l]));
  for (const l of byItem) merged.set(l.id, l);
  return [...merged.values()];
};

export const lotHandlingUnits = (lotId: string) =>
  rows<{ id: string; hu_code: string; qr_token: string; qty_remaining: number; uom: string; status: string; locations: { code: string } | null }>(
    supabase.from('handling_units')
      .select('id, hu_code, qr_token, qty_remaining, uom, status, locations(code)')
      .eq('lot_id', lotId).order('hu_code')
  );

/** v_trace_forward — kolom pasti dari neotrace_schema.sql. */
export interface TraceForwardRow {
  source_lot_id: string; source_lot_code: string; source_item: string;
  batch_id: string; batch_no: string; product_name: string; qty_used: number;
  output_lot_id: string | null; do_no: string | null; customer_name: string | null;
  qty_shipped: number | null; shipped_at: string | null; do_status: string | null;
}

export interface ConsignmentRow {
  customer_id: string; customer_name: string; item_code: string; item_name: string;
  qty_received: number; qty_consumed: number; qty_on_hand: number; qty_variance: number;
}

/* ------------------------------------------------- konsol gudang (Fase 2) */

export interface WarehouseMapRow {
  rack_code: string; level_no: number; position_no: number | null; code: string;
  type: string; allergen_policy: string;
  current_hu_count: number | null; utilisation_pct: number | null;
  holds_allergen: boolean | null; contents: string | null;
}
export const warehouseMap = () =>
  rows<WarehouseMapRow>(supabase.from('v_warehouse_map').select('*'));

export interface DockToStockRow {
  receipt_no: string | null; received_at: string; putaway_at: string; hours_to_stock: number;
  supplier_name: string | null; item_name: string; location_code: string | null; deviated: boolean;
}
export const dockToStock = () =>
  rows<DockToStockRow>(
    supabase.from('v_dock_to_stock').select('*').order('putaway_at', { ascending: false }).limit(100)
  );

export interface PutawayComplianceRow {
  week: string; tasks_done: number; deviations: number; compliance_pct: number | null;
}
export const putawayCompliance = () =>
  rows<PutawayComplianceRow>(supabase.from('v_putaway_compliance').select('*').limit(12));

export interface PickPerformanceRow {
  pick_list_id: string; doc_no: string; batch_no: string | null; product_name: string | null;
  total_lines: number; lines_done: number; lines_short: number; fefo_overrides: number;
  minutes_taken: number | null; picker: string | null;
}
export const pickPerformance = () =>
  rows<PickPerformanceRow>(supabase.from('v_pick_performance').select('*').limit(50));

/* ------------------------------------------------------- monitoring */

export interface AlertRow {
  id: number; type: string; severity: string; title: string; body: string | null;
  created_at: string; read_at: string | null;
}
/** Log peringatan untuk dasbor monitoring — semua status, bukan hanya yang belum dibaca. */
export const recentAlerts = (limit = 20) =>
  rows<AlertRow>(
    supabase.from('notifications')
      .select('id, type, severity, title, body, created_at, read_at')
      .order('created_at', { ascending: false })
      .limit(limit)
  );

/* --------------------------------------------------------- notifikasi */

export async function markNotificationRead(id: number) {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/* ------------------------------------------------------------- profil */

export interface Profile { id: string; full_name: string | null; role: string; is_active: boolean }

export async function myProfile(): Promise<Profile | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data, error } = await supabase
    .from('profiles').select('id, full_name, role, is_active').eq('id', auth.user.id).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}
