/**
 * NEOTRACE — API layer Fase 3
 * Wave picking · sesi kerja & KPI · analitik perputaran
 */
import { supabase, parseDbError } from './api';

/* ------------------------------------------------------------------ tipe */

export type PickStrategy = 'DISCRETE' | 'BATCH' | 'ZONE' | 'CLUSTER';
export type TaskType =
  | 'RECEIVE' | 'PUTAWAY' | 'PICK' | 'PACK' | 'LOAD'
  | 'COUNT' | 'TRANSFER' | 'PRODUCTION' | 'CLEANING' | 'OTHER';

export interface WaveStop {
  wave_id: string;
  wave_no: string;
  wave_sequence: number;
  location_code: string | null;
  rack_code: string | null;
  level_no: number | null;
  item_name: string;
  lot_code: string | null;
  hu_code: string | null;
  total_qty: number;
  uom: string;
  all_done: boolean;
  splits: { tote: string; batch: string; qty: number; line_id: string; status: string }[];
}

export const WAVE_MESSAGES: Record<string, { title: string; hint: string }> = {
  NO_BATCH:      { title: 'Tidak ada batch dipilih',      hint: 'Pilih minimal satu batch untuk dibentuk gelombang.' },
  EMPTY_WAVE:    { title: 'Gelombang kosong',             hint: 'Tidak ada baris pick yang masuk zona yang dipilih.' },
  SESSION_OPEN:  { title: 'Sesi kerja belum ditutup',     hint: 'Tutup tugas sebelumnya sebelum memulai yang baru.' },
  SESSION_NOT_FOUND_OR_CLOSED: { title: 'Sesi tidak ditemukan', hint: 'Sesi mungkin sudah ditutup otomatis.' },
};

export function waveMessage(code: string) {
  return WAVE_MESSAGES[code] ?? { title: 'Tidak dapat diproses', hint: code };
}

/* --------------------------------------------------------- wave picking */

/** Bentuk gelombang dari beberapa batch. Setiap batch dapat kode tote sendiri. */
export async function generateWave(
  batchIds: string[],
  strategy: PickStrategy = 'BATCH',
  zoneId?: string,
  plannedFor?: string
): Promise<string> {
  const { data, error } = await supabase.rpc('generate_wave', {
    p_batch_ids: batchIds,
    p_strategy: strategy,
    p_zone_id: zoneId ?? null,
    p_planned_for: plannedFor ?? null,
  });
  if (error) throw parseDbError(error);
  return data as string;
}

/**
 * Lembar kerja gelombang. Baris digabung per lokasi supaya petugas berhenti
 * sekali di tiap rak, lalu membagi ke beberapa tote.
 */
export async function getWaveSheet(waveId: string): Promise<WaveStop[]> {
  const { data, error } = await supabase
    .from('v_wave_pick_sheet')
    .select('*')
    .eq('wave_id', waveId)
    .order('wave_sequence');
  if (error) throw parseDbError(error);
  return data as WaveStop[];
}

export async function assignWave(waveId: string, userId: string) {
  const { error } = await supabase
    .from('pick_waves')
    .update({ assigned_to: userId, status: 'ASSIGNED', started_at: new Date().toISOString() })
    .eq('id', waveId);
  if (error) throw parseDbError(error);
}

export async function listOpenWaves() {
  const { data, error } = await supabase
    .from('pick_waves')
    .select('id, wave_no, strategy, status, planned_for, started_at, profiles:assigned_to(full_name)')
    .neq('status', 'COMPLETED')
    .order('planned_for', { nullsFirst: false });
  if (error) throw parseDbError(error);
  return data;
}

/** Batch yang siap dijadwalkan: sudah punya formula dan belum masuk gelombang. */
export async function pickableBatches() {
  const { data, error } = await supabase
    .from('production_batches')
    .select('id, batch_no, target_qty, status, items!inner(name), pick_lists(id, wave_id)')
    .in('status', ['PLANNED', 'RUNNING'])
    .not('formula_id', 'is', null)
    .order('batch_no');
  if (error) throw parseDbError(error);
  return (data ?? []).filter((b) => {
    const pls = (b as unknown as { pick_lists: { wave_id: string | null }[] }).pick_lists ?? [];
    return pls.every((p) => !p.wave_id);
  });
}

export async function wavePerformance(days = 30) {
  const { data, error } = await supabase
    .from('v_wave_performance')
    .select('*')
    .limit(days);
  if (error) throw parseDbError(error);
  return data;
}

/* ------------------------------------------------------------ sesi kerja */

/**
 * Mulai sesi kerja. Database menolak bila masih ada sesi terbuka —
 * satu orang tidak bisa mengerjakan dua tugas sekaligus.
 */
export async function startLabour(
  taskType: TaskType, referenceId?: string, referenceNo?: string,
  zoneId?: string, deviceId?: string
): Promise<string> {
  const { data, error } = await supabase.rpc('start_labour', {
    p_task_type: taskType,
    p_reference_id: referenceId ?? null,
    p_reference_no: referenceNo ?? null,
    p_zone_id: zoneId ?? null,
    p_device: deviceId ?? null,
  });
  if (error) throw parseDbError(error);
  return data as string;
}

export async function endLabour(sessionId: string, units?: number, lines?: number) {
  const { error } = await supabase.rpc('end_labour', {
    p_session_id: sessionId,
    p_units: units ?? null,
    p_lines: lines ?? null,
  });
  if (error) throw parseDbError(error);
}

export async function openSession() {
  const { data, error } = await supabase
    .from('labour_sessions')
    .select('id, task_type, reference_no, started_at')
    .is('ended_at', null)
    .maybeSingle();
  if (error) throw parseDbError(error);
  return data;
}

/**
 * KPI tenaga kerja. Default menampilkan agregat tim; angka per individu
 * hanya untuk supervisor — lihat catatan pada view di database.
 */
export async function labourKpi(from: string, to: string, userId?: string) {
  let q = supabase.from('v_labour_kpi').select('*').gte('day', from).lte('day', to);
  if (userId) q = q.eq('user_id', userId);
  const { data, error } = await q.order('day', { ascending: false });
  if (error) throw parseDbError(error);
  return data;
}

/** Agregat tim — bentuk yang sebaiknya jadi tampilan utama dasbor. */
export async function teamKpi(from: string, to: string) {
  const rows = await labourKpi(from, to);
  const byTask = new Map<string, { minutes: number; lines: number; people: Set<string> }>();
  for (const r of (rows ?? []) as Record<string, never>[]) {
    const k = r['task_type'] as string;
    const cur = byTask.get(k) ?? { minutes: 0, lines: 0, people: new Set<string>() };
    cur.minutes += Number(r['total_min'] ?? 0);
    cur.lines += Number(r['total_lines'] ?? 0);
    cur.people.add(String(r['user_id']));
    byTask.set(k, cur);
  }
  return [...byTask.entries()].map(([task, v]) => ({
    task_type: task,
    people: v.people.size,
    total_hours: Math.round((v.minutes / 60) * 10) / 10,
    total_lines: v.lines,
    lines_per_hour: v.minutes ? Math.round((v.lines / (v.minutes / 60)) * 10) / 10 : null,
  }));
}

export async function pickAccuracy(weekFrom: string) {
  const { data, error } = await supabase
    .from('v_pick_accuracy').select('*').gte('week', weekFrom).order('week', { ascending: false });
  if (error) throw parseDbError(error);
  return data;
}

/* --------------------------------------------------------------- analitik */

export async function runAbcClassification(): Promise<number> {
  const { data, error } = await supabase.rpc('classify_abc');
  if (error) throw parseDbError(error);
  return data as number;
}

export async function inventoryTurnover(abcClass?: 'A' | 'B' | 'C') {
  let q = supabase.from('v_inventory_turnover').select('*');
  if (abcClass) q = q.eq('abc_class', abcClass);
  const { data, error } = await q.order('value_on_hand', { ascending: false });
  if (error) throw parseDbError(error);
  return data;
}

export async function slowMoving() {
  const { data, error } = await supabase.from('v_slow_moving').select('*');
  if (error) throw parseDbError(error);
  return data;
}

export async function warehouseUtilisation() {
  const { data, error } = await supabase.from('v_warehouse_utilisation').select('*');
  if (error) throw parseDbError(error);
  return data;
}

/** Satu baris angka untuk layar manajemen. */
export async function opsScorecard() {
  const { data, error } = await supabase.from('v_ops_scorecard').select('*').single();
  if (error) throw parseDbError(error);
  return data as {
    open_putaway: number; open_picks: number; open_waves: number;
    avg_dock_to_stock_hours: number | null;
    putaway_compliance_pct: number | null;
    fefo_compliance_pct: number | null;
    avg_wave_lines_per_hour: number | null;
    slow_moving_items: number;
    total_inventory_value: number | null;
  };
}
