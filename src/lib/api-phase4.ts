/**
 * NEOTRACE — API layer Fase 4
 * Monitor sinkronisasi ERP · peramalan · titik pemesanan ulang
 *
 * Pengiriman ke ERP dilakukan Edge Function `erp-sync`, bukan dari browser —
 * kredensial ERP tidak boleh ada di bundle klien. Layer ini hanya membaca
 * antrean dan menyediakan intervensi manual untuk pesan DEAD (E20).
 */
import { supabase, parseDbError } from './api';

/* ------------------------------------------------------------ sinkronisasi */

export interface SyncHealthRow {
  endpoint: string;
  direction: string;
  pending: number;
  failed: number;
  dead: number;
  acked_24h: number;
  last_ack: string | null;
  last_error_at: string | null;
  last_error: string | null;
}

export async function syncHealth(): Promise<SyncHealthRow[]> {
  const { data, error } = await supabase.from('v_sync_health').select('*').order('endpoint');
  if (error) throw parseDbError(error);
  return (data ?? []) as SyncHealthRow[];
}

export type SyncStatus = 'PENDING' | 'CLAIMED' | 'SENT' | 'ACKED' | 'FAILED' | 'DEAD' | 'SKIPPED';

export interface OutboxRow {
  id: number;
  entity_type: string;
  entity_id: string;
  operation: string;
  idempotency_key: string;
  status: SyncStatus;
  attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  acked_at: string | null;
  external_id: string | null;
  last_error: string | null;
  created_at: string;
  integration_endpoints: { code: string } | null;
}

export async function outboxRows(status?: SyncStatus, limit = 50): Promise<OutboxRow[]> {
  let q = supabase
    .from('sync_outbox')
    .select('id, entity_type, entity_id, operation, idempotency_key, status, attempts, next_attempt_at, sent_at, acked_at, external_id, last_error, created_at, integration_endpoints(code)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw parseDbError(error);
  return (data ?? []) as unknown as OutboxRow[];
}

/**
 * Antre ulang pesan DEAD atau FAILED. idempotency_key tidak diubah — itulah
 * yang mencegah ERP membuat dokumen kedua saat pesan yang sama dikirim lagi.
 */
export async function requeueMessage(id: number) {
  const { error } = await supabase
    .from('sync_outbox')
    .update({ status: 'PENDING', attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null })
    .eq('id', id)
    .in('status', ['DEAD', 'FAILED']);
  if (error) throw parseDbError(error);
}

/** Lewati pesan yang memang tidak boleh dikirim (mis. dokumen dibatalkan). */
export async function skipMessage(id: number, reason: string) {
  const { error } = await supabase
    .from('sync_outbox')
    .update({ status: 'SKIPPED', last_error: `DILEWATI MANUAL: ${reason}` })
    .eq('id', id)
    .in('status', ['DEAD', 'FAILED']);
  if (error) throw parseDbError(error);
}

/** Lepas klaim worker yang mati di tengah jalan (>15 menit). */
export async function reclaimStuck(): Promise<number> {
  const { data, error } = await supabase.rpc('reclaim_stuck_outbox');
  if (error) throw parseDbError(error);
  return data as number;
}

export interface EndpointRow {
  id: string; code: string; name: string; direction: string;
  entity_types: string[]; is_active: boolean; max_attempts: number;
  last_success_at: string | null; last_error_at: string | null; last_error: string | null;
}

export async function endpoints(): Promise<EndpointRow[]> {
  const { data, error } = await supabase
    .from('integration_endpoints')
    .select('id, code, name, direction, entity_types, is_active, max_attempts, last_success_at, last_error_at, last_error')
    .order('code');
  if (error) throw parseDbError(error);
  return (data ?? []) as EndpointRow[];
}

/* -------------------------------------------------------------- peramalan */

export interface ForecastRow {
  id: string;
  item_id: string;
  period_start: string;
  period_end: string;
  forecast_qty: number;
  confidence_low: number | null;
  confidence_high: number | null;
  method: string;
  actual_qty: number | null;
  abs_error: number | null;
  generated_at: string;
  items: { code: string; name: string; base_uom: string; abc_class: string | null } | null;
}

export async function forecasts(periodStart?: string): Promise<ForecastRow[]> {
  let q = supabase
    .from('demand_forecasts')
    .select('id, item_id, period_start, period_end, forecast_qty, confidence_low, confidence_high, method, actual_qty, abs_error, generated_at, items(code, name, base_uom, abc_class)')
    .order('period_start', { ascending: false })
    .limit(200);
  if (periodStart) q = q.eq('period_start', periodStart);
  const { data, error } = await q;
  if (error) throw parseDbError(error);
  return (data ?? []) as unknown as ForecastRow[];
}

export async function runForecast(months = 3): Promise<number> {
  const { data, error } = await supabase.rpc('forecast_moving_average', { p_months: months });
  if (error) throw parseDbError(error);
  return data as number;
}

export async function backfillActuals(): Promise<number> {
  const { data, error } = await supabase.rpc('backfill_forecast_actuals');
  if (error) throw parseDbError(error);
  return data as number;
}

export interface ForecastAccuracyRow {
  method: string; item_code: string; item_name: string; abc_class: string | null;
  periods: number; mae: number | null; mape_pct: number | null; bias: number | null;
}

export async function forecastAccuracy(): Promise<ForecastAccuracyRow[]> {
  const { data, error } = await supabase.from('v_forecast_accuracy').select('*');
  if (error) throw parseDbError(error);
  return (data ?? []) as ForecastAccuracyRow[];
}

/**
 * Jumlah periode minimum sebelum saran reorder boleh ditampilkan.
 * RAID R44: peramalan dengan data tipis tidak boleh dipakai sebagai angka
 * perencanaan. Data konsumsi 12 bulan penuh baru ada Agu 2027.
 */
export const MIN_PERIODS_FOR_REORDER = 12;

export interface ReorderRow {
  code: string; name: string; abc_class: string | null;
  qty_on_hand: number; forecast_next_month: number;
  lead_time_days: number; safety_stock_qty: number | null;
  reorder_level: number; needs_reorder: boolean; days_of_cover: number | null;
}

export async function reorderSuggestions(): Promise<ReorderRow[]> {
  const { data, error } = await supabase.from('v_reorder_suggestions').select('*').order('code');
  if (error) throw parseDbError(error);
  return (data ?? []) as ReorderRow[];
}

export interface ConsumptionRow {
  item_id: string; item_code: string; item_name: string;
  period: string; qty_consumed: number; batch_count: number; avg_unit_cost: number | null;
}

export async function consumptionHistory(itemId?: string): Promise<ConsumptionRow[]> {
  let q = supabase.from('v_consumption_history').select('*').order('period', { ascending: false });
  if (itemId) q = q.eq('item_id', itemId);
  const { data, error } = await q.limit(200);
  if (error) throw parseDbError(error);
  return (data ?? []) as ConsumptionRow[];
}

export async function upsertReorderPoint(itemId: string, p: {
  lead_time_days: number; safety_stock_qty?: number | null;
  reorder_qty?: number | null; min_order_qty?: number | null;
}) {
  const { error } = await supabase.from('reorder_points').upsert({
    item_id: itemId,
    lead_time_days: p.lead_time_days,
    safety_stock_qty: p.safety_stock_qty ?? null,
    reorder_qty: p.reorder_qty ?? null,
    min_order_qty: p.min_order_qty ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw parseDbError(error);
}
