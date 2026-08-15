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
export const listPartners = (type: 'SUPPLIER' | 'CUSTOMER') =>
  rows<Partner>(supabase.from('partners').select('id, code, name, type').eq('type', type).order('name'));

export interface Location { id: string; code: string; name: string | null; type: string }
export const listLocations = () =>
  rows<Location>(supabase.from('locations').select('id, code, name, type').order('code'));

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
      .in('status', open ? ['PLANNED', 'IN_PROGRESS', 'QC_HOLD'] : ['CLOSED'])
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(50)
  );

export interface FormulaLine {
  id: string; item_id: string; qty: number; uom: string; scrap_pct: number | null;
  items: { code: string; name: string } | null;
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
      .select('id, item_id, qty, uom, scrap_pct, items(code, name)')
      .eq('formula_id', batch.formula_id)
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

export interface CcpDefinition {
  id: string; code: string; name: string | null;
  min_value: number | null; max_value: number | null; uom: string | null; is_critical: boolean;
}
export const ccpDefinitions = (itemId: string) =>
  rows<CcpDefinition>(
    supabase.from('ccp_definitions')
      .select('id, code, name, min_value, max_value, uom, is_critical')
      .eq('item_id', itemId).order('code')
  );

/* -------------------------------------------------------------- telusur */

export interface LotRow {
  id: string; lot_code: string; status: string; expiry_date: string | null;
  halal_valid_until: string | null; owner_type: string; unit_cost: number | null;
  qty_received: number; items: { code: string; name: string; base_uom: string } | null;
  partners: { name: string } | null;
}

/** Cari lot berdasarkan kode lot atau nama/kode bahan. */
export const searchLots = (q: string) =>
  rows<LotRow>(
    supabase
      .from('lots')
      .select('id, lot_code, status, expiry_date, halal_valid_until, owner_type, unit_cost, qty_received, items!inner(code, name, base_uom), partners(name)')
      .or(`lot_code.ilike.%${q}%,items.name.ilike.%${q}%,items.code.ilike.%${q}%`)
      .order('lot_code')
      .limit(40)
  );

export const lotHandlingUnits = (lotId: string) =>
  rows<{ id: string; hu_code: string; qr_token: string; qty_remaining: number; uom: string; status: string; locations: { code: string } | null }>(
    supabase.from('handling_units')
      .select('id, hu_code, qr_token, qty_remaining, uom, status, locations(code)')
      .eq('lot_id', lotId).order('hu_code')
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
