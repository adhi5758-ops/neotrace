/**
 * NEOTRACE — API layer Fase 6
 * Stock opname · pembatalan transaksi · status inventori fleksibel ·
 * multi-UOM · packing · replenishment · bulk picking · landed cost ·
 * item family/putaway strategy · log cetak label.
 */
import { supabase, parseDbError } from './api';

/* ------------------------------------------------------------ cycle count */

export type CycleCountStatus = 'OPEN' | 'COUNTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface CycleCountRow {
  id: string;
  doc_no: string;
  location_id: string;
  hu_id: string;
  item_id: string;
  system_qty: number;
  counted_qty: number | null;
  status: CycleCountStatus;
  scheduled_for: string | null;
  remarks: string | null;
  created_at: string;
  locations: { code: string } | null;
  handling_units: { hu_code: string } | null;
  items: { code: string; name: string; base_uom: string } | null;
}

export async function listCycleCounts(status?: CycleCountStatus): Promise<CycleCountRow[]> {
  let q = supabase
    .from('cycle_counts')
    .select('id, doc_no, location_id, hu_id, item_id, system_qty, counted_qty, status, scheduled_for, remarks, created_at, locations(code), handling_units(hu_code), items(code, name, base_uom)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw parseDbError(error);
  return (data ?? []) as unknown as CycleCountRow[];
}

export async function getCycleCount(id: string): Promise<CycleCountRow> {
  const { data, error } = await supabase
    .from('cycle_counts')
    .select('id, doc_no, location_id, hu_id, item_id, system_qty, counted_qty, status, scheduled_for, remarks, created_at, locations(code), handling_units(hu_code), items(code, name, base_uom)')
    .eq('id', id)
    .single();
  if (error) throw parseDbError(error);
  return data as unknown as CycleCountRow;
}

export async function generateCycleCounts(locationId: string, scheduledFor?: string): Promise<number> {
  const { data, error } = await supabase.rpc('generate_cycle_counts', {
    p_location_id: locationId,
    p_scheduled_for: scheduledFor ?? null,
  });
  if (error) throw parseDbError(error);
  return data as number;
}

export async function submitCycleCount(id: string, countedQty: number) {
  const { error } = await supabase.rpc('submit_cycle_count', { p_id: id, p_counted_qty: countedQty });
  if (error) throw parseDbError(error);
}

export async function approveCycleCount(id: string, reason?: string) {
  const { error } = await supabase.rpc('approve_cycle_count', { p_id: id, p_reason: reason ?? null });
  if (error) throw parseDbError(error);
}

export async function rejectCycleCount(id: string, reason: string) {
  const { error } = await supabase.rpc('reject_cycle_count', { p_id: id, p_reason: reason });
  if (error) throw parseDbError(error);
}

/* --------------------------------------------------------- pembatalan (reversal) */

export async function reverseReceipt(lotId: string, reason: string) {
  const { error } = await supabase.rpc('reverse_receipt', { p_lot_id: lotId, p_reason: reason });
  if (error) throw parseDbError(error);
}

export async function reversePick(lineId: string, reason: string) {
  const { error } = await supabase.rpc('reverse_pick', { p_line_id: lineId, p_reason: reason });
  if (error) throw parseDbError(error);
}

export async function reverseShipment(doId: string, reason: string) {
  const { error } = await supabase.rpc('reverse_shipment', { p_do_id: doId, p_reason: reason });
  if (error) throw parseDbError(error);
}

/* ------------------------------------------------------- status inventori */

export interface InventoryStatusRow {
  id: string; code: string; name: string; blocks_sale: boolean; description: string | null; is_active: boolean;
}

export async function listInventoryStatuses(): Promise<InventoryStatusRow[]> {
  const { data, error } = await supabase.from('inventory_statuses').select('*').eq('is_active', true).order('code');
  if (error) throw parseDbError(error);
  return (data ?? []) as InventoryStatusRow[];
}

export async function setHuInventoryStatus(huId: string, statusId: string, reason?: string) {
  const { error } = await supabase.rpc('set_hu_inventory_status', { p_hu_id: huId, p_status_id: statusId, p_reason: reason ?? null });
  if (error) throw parseDbError(error);
}

/* ----------------------------------------------------------------- UOM */

export async function convertToBase(itemId: string, qty: number, uom: string): Promise<number> {
  const { data, error } = await supabase.rpc('convert_to_base', { p_item_id: itemId, p_qty: qty, p_uom: uom });
  if (error) throw parseDbError(error);
  return data as number;
}

/* ------------------------------------------------------------- packing */

export async function confirmPacking(pickListId: string) {
  const { error } = await supabase.rpc('confirm_packing', { p_pick_list_id: pickListId });
  if (error) throw parseDbError(error);
}

/* ------------------------------------------------------- replenishment */

export interface ReplenishmentSuggestion {
  item_id: string;
  item_code: string;
  item_name: string;
  primary_qty: number;
  min_stock: number;
  suggested_qty: number;
  source_location_id: string;
  source_location_code: string;
  source_hu_id: string;
  uom: string;
}

export async function replenishmentSuggestions(): Promise<ReplenishmentSuggestion[]> {
  const { data, error } = await supabase.rpc('generate_replenishment_suggestions');
  if (error) throw parseDbError(error);
  return (data ?? []) as ReplenishmentSuggestion[];
}

/* --------------------------------------------------------- bulk picking */

export async function generatePickListFromDos(doIds: string[]): Promise<string> {
  const { data, error } = await supabase.rpc('generate_pick_list_from_dos', { p_do_ids: doIds });
  if (error) throw parseDbError(error);
  return data as string;
}

/* -------------------------------------------------- item family & putaway */

export interface ItemFamilyRow { id: string; code: string; name: string; description: string | null }

export async function listItemFamilies(): Promise<ItemFamilyRow[]> {
  const { data, error } = await supabase.from('item_families').select('*').order('code');
  if (error) throw parseDbError(error);
  return (data ?? []) as ItemFamilyRow[];
}

/* ---------------------------------------------------------- label print log */

export async function logLabelPrint(kind: string, huId?: string, locationId?: string, isReprint = false) {
  const { error } = await supabase.from('label_print_log').insert({
    label_kind: kind, hu_id: huId ?? null, location_id: locationId ?? null, is_reprint: isReprint,
  });
  if (error) throw parseDbError(error);
}
