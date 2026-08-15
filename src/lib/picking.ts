/**
 * NEOTRACE Fase 2 — pick list & staging (P23).
 *
 * Pick list terbit dari formula batch, proporsional terhadap target qty, dan
 * diurutkan mengikuti pick_sequence gudang. Konfirmasi wajib lewat scan:
 * database menolak kemasan bahan yang salah (WRONG_ITEM) dan lot yang tidak
 * layak pakai (kedaluwarsa / halal habis / belum release).
 */
import { supabase, parseDbError } from './api';

export type PickStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'SHORT' | 'COMPLETED' | 'CANCELLED';

export interface PickList {
  id: string;
  doc_no: string;
  source_type: string;
  batch_id: string | null;
  staging_location_id: string | null;
  assigned_to: string | null;
  status: PickStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  production_batches: { batch_no: string; target_qty: number; items: { name: string } | null } | null;
}

export interface PickLine {
  id: string;
  sequence: number;
  item_id: string;
  suggested_lot_id: string | null;
  suggested_hu_id: string | null;
  from_location_id: string | null;
  qty_requested: number;
  qty_picked: number | null;
  uom: string;
  status: PickStatus;
  short_reason: string | null;
  fefo_override: boolean;
  items: { code: string; name: string } | null;
  lots: { lot_code: string; expiry_date: string | null } | null;
}

/* --------------------------------------------------------------- daftar */

export async function listPickLists(onlyOpen = true): Promise<PickList[]> {
  let q = supabase
    .from('pick_lists')
    .select('id, doc_no, source_type, batch_id, staging_location_id, assigned_to, status, started_at, completed_at, created_at, production_batches(batch_no, target_qty, items(name))')
    .order('created_at', { ascending: false });
  if (onlyOpen) q = q.neq('status', 'COMPLETED').neq('status', 'CANCELLED');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as PickList[];
}

export async function openPickCount(): Promise<number> {
  const { count, error } = await supabase
    .from('pick_lists')
    .select('id', { count: 'exact', head: true })
    .in('status', ['OPEN', 'ASSIGNED', 'IN_PROGRESS']);
  if (error) throw error;
  return count ?? 0;
}

export async function pickLines(pickListId: string): Promise<PickLine[]> {
  const { data, error } = await supabase
    .from('pick_list_lines')
    .select('id, sequence, item_id, suggested_lot_id, suggested_hu_id, from_location_id, qty_requested, qty_picked, uom, status, short_reason, fefo_override, items(code, name), lots!pick_list_lines_suggested_lot_id_fkey(lot_code, expiry_date)')
    .eq('pick_list_id', pickListId)
    .order('sequence');
  if (error) throw error;
  return (data ?? []) as unknown as PickLine[];
}

/** Baris yang sudah dipetik, untuk mencatat konsumsi batch (P28). */
export async function pickedLines(pickListId: string) {
  const { data, error } = await supabase
    .from('pick_list_lines')
    .select('id, item_id, picked_lot_id, picked_hu_id, qty_picked, uom, status, fefo_override, override_reason')
    .eq('pick_list_id', pickListId)
    .in('status', ['COMPLETED', 'SHORT'])
    .not('picked_lot_id', 'is', null);
  if (error) throw error;
  return (data ?? []) as {
    id: string; item_id: string; picked_lot_id: string; picked_hu_id: string | null;
    qty_picked: number; uom: string; status: PickStatus;
    fefo_override: boolean; override_reason: string | null;
  }[];
}

/* --------------------------------------------------------------- aksi */

/** Terbitkan pick list dari formula batch. Menolak bila batch sudah punya satu. */
export async function generatePickList(batchId: string): Promise<string> {
  const { data, error } = await supabase.rpc('generate_pick_list_from_batch', { p_batch_id: batchId });
  if (error) throw parseDbError(error);
  return data as string;
}

export async function assignPicker(pickListId: string, profileId: string | null) {
  const { error } = await supabase
    .from('pick_lists')
    .update({ assigned_to: profileId, status: profileId ? 'ASSIGNED' : 'OPEN' })
    .eq('id', pickListId);
  if (error) throw parseDbError(error);
}

/** Tandai mulai — `v_pick_performance` menghitung menit dari started_at. */
export async function startPicking(pickListId: string) {
  const { error } = await supabase
    .from('pick_lists')
    .update({ started_at: new Date().toISOString(), status: 'IN_PROGRESS' })
    .eq('id', pickListId)
    .is('started_at', null);
  if (error) throw parseDbError(error);
}

export async function cancelPickList(pickListId: string) {
  const { error } = await supabase.from('pick_lists').update({ status: 'CANCELLED' }).eq('id', pickListId);
  if (error) throw parseDbError(error);
}

export interface ConfirmPickInput {
  lineId: string;
  huId: string;
  qty: number;
  overrideReason?: string;
}

/**
 * Konfirmasi satu baris. qty kurang dari permintaan → baris jadi SHORT,
 * bukan gagal: kekurangan bahan adalah kenyataan gudang yang harus tercatat.
 */
export async function confirmPick({ lineId, huId, qty, overrideReason }: ConfirmPickInput) {
  const { error } = await supabase.rpc('confirm_pick', {
    p_line_id: lineId,
    p_hu_id: huId,
    p_qty: qty,
    p_override_reason: overrideReason?.trim() || null,
    p_scan_event_id: null,
  });
  if (error) throw parseDbError(error);
}

/* ------------------------------------------------------------- staging */

export interface StagingBoardRow {
  location_code: string; location_name: string | null; line_code: string | null;
  batch_no: string | null; product_name: string | null; assigned_at: string | null;
  hours_occupied: number | null; pick_list_no: string | null; pick_status: string | null;
}

export const stagingBoard = async (): Promise<StagingBoardRow[]> => {
  const { data, error } = await supabase.from('v_staging_board').select('*').order('location_code');
  if (error) throw error;
  return (data ?? []) as StagingBoardRow[];
};

/** Satu lokasi staging hanya untuk satu batch — indeks unik di DB yang menjaga. */
export async function assignStaging(locationId: string, batchId: string, lineCode?: string): Promise<string> {
  const { data, error } = await supabase.rpc('assign_staging', {
    p_location_id: locationId,
    p_batch_id: batchId,
    p_line_code: lineCode?.trim() || null,
  });
  if (error) throw parseDbError(error);
  return data as string;
}

export async function releaseStaging(assignmentId: string) {
  const { error } = await supabase.rpc('release_staging', { p_assignment_id: assignmentId });
  if (error) throw parseDbError(error);
}

/** Penugasan staging yang masih aktif, untuk tombol lepas. */
export async function openStagingAssignments() {
  const { data, error } = await supabase
    .from('staging_assignments')
    .select('id, location_id, batch_id, line_code, assigned_at, locations(code)')
    .is('released_at', null);
  if (error) throw error;
  return (data ?? []) as unknown as {
    id: string; location_id: string; batch_id: string | null; line_code: string | null;
    assigned_at: string; locations: { code: string } | null;
  }[];
}
