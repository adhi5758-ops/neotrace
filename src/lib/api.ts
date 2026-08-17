/**
 * NEOTRACE — API layer (Fase 1)
 * PT Neopangan Selaras Indonesia (Neofood) · Sauce Division
 *
 * Semua akses data lewat file ini. Aturan bisnis (FEFO, expiry, halal, QC)
 * ditegakkan di database — layer ini hanya menerjemahkan error Postgres
 * menjadi pesan yang bisa dibaca operator di lantai produksi.
 *
 * npm i @supabase/supabase-js
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Aplikasi tetap boot tanpa .env supaya layar setup bisa tampil, bukan layar putih. */
export const isConfigured = Boolean(URL && KEY);

export const supabase: SupabaseClient = createClient(
  URL || 'http://localhost:54321',
  KEY || 'anon-belum-diisi',
  { auth: { persistSession: true, autoRefreshToken: true } }
);

/* ------------------------------------------------------------------ tipe */

export type ScanAction =
  | 'LOOKUP' | 'RECEIVE' | 'ISSUE' | 'TRANSFER' | 'PICK' | 'COUNT' | 'SHIP' | 'VERIFY' | 'SCRAP';

export type ScanErrorCode =
  | 'NOT_FOUND' | 'LOT_EXPIRED' | 'HALAL_EXPIRED' | 'LOT_NOT_RELEASED' | 'OFFLINE';

export interface ScanResult {
  ok: boolean;
  error: ScanErrorCode | null;
  hu_id?: string;
  hu_code?: string;
  hu_status?: string;
  qty_remaining?: number;
  uom?: string;
  lot_id?: string;
  lot_code?: string;
  lot_status?: string;
  expiry_date?: string | null;
  halal_valid_until?: string | null;
  owner_type?: 'OWN' | 'CONSIGNED';
  owner_name?: string | null;
  item_code?: string;
  item_name?: string;
  item_type?: string;
  location_code?: string | null;
  allergens?: string[];
  is_expired?: boolean;
  is_halal_expired?: boolean;
}

export interface FefoSuggestion {
  lot_id: string;
  lot_code: string;
  hu_id: string;
  hu_code: string;
  qty_available: number;
  expiry_date: string | null;
  location_code: string | null;
  suggested_qty: number;
}

/** Pesan operator dalam Bahasa Indonesia untuk tiap kode error. */
export const SCAN_MESSAGES: Record<ScanErrorCode, { title: string; hint: string }> = {
  NOT_FOUND:        { title: 'Label tidak dikenali',        hint: 'Cetak ulang label atau catat manual ke supervisor.' },
  LOT_EXPIRED:      { title: 'Bahan sudah kedaluwarsa',     hint: 'Jangan dipakai. Pindahkan ke area reject.' },
  HALAL_EXPIRED:    { title: 'Sertifikat halal habis',      hint: 'Hubungi QA sebelum bahan ini dipakai.' },
  LOT_NOT_RELEASED: { title: 'Bahan belum lolos QC',        hint: 'Masih tertahan karantina. Tunggu release dari QA.' },
  OFFLINE:          { title: 'Tersimpan, menunggu sinyal',  hint: 'Data akan terkirim otomatis saat jaringan kembali.' },
};

/** Menerjemahkan error Postgres (RAISE EXCEPTION 'CODE: pesan') jadi objek. */
export function parseDbError(e: unknown): { code: string; message: string } {
  const raw = (e as { message?: string })?.message ?? String(e);
  const m = raw.match(/^([A-Z_]+):\s*(.*)$/);
  if (m) return { code: m[1], message: m[2] };
  if (/duplicate key/i.test(raw)) return { code: 'DUPLICATE', message: 'Data sudah pernah dicatat.' };
  return { code: 'UNKNOWN', message: raw };
}

/* -------------------------------------------------------------- scanning */

/**
 * Resolusi QR. Fungsi RPC di database sekaligus mencatat scan_events —
 * termasuk saat gagal, karena scan gagal adalah bukti kontrol berjalan.
 */
export async function resolveQr(
  token: string,
  action: ScanAction = 'LOOKUP',
  locationId?: string,
  deviceId?: string
): Promise<ScanResult> {
  const { data, error } = await supabase.rpc('resolve_qr', {
    p_token: token,
    p_action: action,
    p_location_id: locationId ?? null,
    p_device: deviceId ?? null,
  });
  if (error) throw error;
  return data as ScanResult;
}

/** Ambil token dari isi QR: URL penuh atau UUID telanjang. */
export function extractToken(raw: string): string | null {
  const trimmed = raw.trim();
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const m = trimmed.match(uuid);
  return m ? m[0] : null;
}

/* ------------------------------------------------------------ penerimaan */

export interface ReceiveInput {
  itemId: string;
  supplierId: string;
  supplierLotNo: string;
  supplierDoNo?: string;
  poNo?: string;
  qty: number;
  uom: string;
  unitCost: number;
  expiryDate: string;
  manufacturedOn?: string;
  halalCertNo?: string;
  halalValidUntil?: string;
  ownerType: 'OWN' | 'CONSIGNED';
  ownerPartnerId?: string;
  temperatureC?: number;
  huCount: number;          // berapa kemasan fisik → berapa label QR
  packageType?: string;
  locationId?: string;
  allergenIds?: number[];
}

export interface ReceiveResult {
  lotId: string;
  lotCode: string;
  handlingUnits: { id: string; hu_code: string; qr_token: string; qty_initial: number }[];
}

/**
 * Penerimaan bahan. Lot dibuat berstatus QUARANTINE — tidak bisa dipakai
 * sampai QA menjalankan release_lot(). Ini penegakan QC hold.
 */
export async function receiveGoods(input: ReceiveInput): Promise<ReceiveResult> {
  const { data: lotCode, error: e1 } = await supabase.rpc('next_doc_no', { p_prefix: 'LOT' });
  if (e1) throw e1;

  const { data: lot, error: e2 } = await supabase
    .from('lots')
    .insert({
      lot_code: lotCode,
      item_id: input.itemId,
      supplier_id: input.supplierId,
      supplier_lot_no: input.supplierLotNo,
      received_at: new Date().toISOString(),
      manufactured_on: input.manufacturedOn ?? null,
      expiry_date: input.expiryDate,
      owner_type: input.ownerType,
      owner_partner_id: input.ownerType === 'CONSIGNED' ? input.ownerPartnerId : null,
      halal_cert_no: input.halalCertNo ?? null,
      halal_valid_until: input.halalValidUntil ?? null,
      unit_cost: input.unitCost,
      qty_received: input.qty,
      status: 'QUARANTINE',
    })
    .select('id, lot_code')
    .single();
  if (e2) throw e2;

  if (input.allergenIds?.length) {
    await supabase.from('lot_allergens').insert(
      input.allergenIds.map((a) => ({ lot_id: lot.id, allergen_id: a }))
    );
  }

  // satu handling unit per kemasan fisik, masing-masing dapat QR sendiri
  const per = input.qty / input.huCount;
  const hus = [];
  for (let i = 0; i < input.huCount; i++) {
    const { data: huCode, error } = await supabase.rpc('next_doc_no', { p_prefix: 'NF-HU' });
    if (error) throw error;
    hus.push({
      hu_code: huCode,
      lot_id: lot.id,
      package_type: input.packageType ?? null,
      qty_initial: per,
      qty_remaining: per,
      uom: input.uom,
      location_id: input.locationId ?? null,
    });
  }
  const { data: created, error: e3 } = await supabase
    .from('handling_units')
    .insert(hus)
    .select('id, hu_code, qr_token, qty_initial');
  if (e3) throw e3;

  return { lotId: lot.id, lotCode: lot.lot_code, handlingUnits: created };
}

/* -------------------------------------------------------------- QC hold */

export async function createIncomingSample(lotId: string, qty: number, uom: string) {
  const { data: sampleNo, error: e1 } = await supabase.rpc('next_doc_no', { p_prefix: 'SMP' });
  if (e1) throw e1;
  const { data, error } = await supabase
    .from('qc_samples')
    .insert({ sample_no: sampleNo, type: 'INCOMING', lot_id: lotId, qty, uom })
    .select('id, sample_no')
    .single();
  if (error) throw error;
  return data;
}

export async function recordTestResult(
  testId: string,
  result: { result_num?: number; result_text?: string; lab_name?: string }
) {
  const { error } = await supabase.from('qc_tests').update(result).eq('id', testId);
  if (error) throw error;
}

/** Hanya QA. Database menolak bila masih ada uji wajib PENDING atau FAIL. */
export async function releaseLot(lotId: string, reason?: string) {
  const { error } = await supabase.rpc('release_lot', { p_lot_id: lotId, p_reason: reason ?? null });
  if (error) throw parseDbError(error);
}

export async function holdLot(lotId: string, reason: string) {
  const { error } = await supabase.rpc('hold_lot', { p_lot_id: lotId, p_reason: reason });
  if (error) throw parseDbError(error);
}

/** Recall: kunci lot sumber + seluruh produk jadi turunannya dalam satu panggilan. */
export async function quarantineCascade(sourceLotId: string, reason: string) {
  const { data, error } = await supabase.rpc('quarantine_lot_cascade', {
    p_source_lot_id: sourceLotId,
    p_reason: reason,
  });
  if (error) throw parseDbError(error);
  return data as { source_lot: string; blocked_lots: number; held_batches: number };
}

export async function listQcPending() {
  const { data, error } = await supabase
    .from('v_qc_pending')
    .select('*')
    .order('hours_on_hold', { ascending: false });
  if (error) throw error;
  return data;
}

/* ------------------------------------------------------------- produksi */

export async function suggestLotsFefo(itemId: string, qty: number): Promise<FefoSuggestion[]> {
  const { data, error } = await supabase.rpc('suggest_lots_fefo', {
    p_item_id: itemId,
    p_qty: qty,
  });
  if (error) throw error;
  return data as FefoSuggestion[];
}

export interface ConsumeInput {
  batchId: string;
  lotId: string;
  itemId: string;
  huId?: string;
  qtyPlanned?: number;
  qtyActual: number;
  uom: string;
  fefoOverride?: boolean;
  overrideReason?: string;
}

/** HU yang sudah tercatat konsumsinya untuk batch ini — dipakai untuk
 * mencegah baris yang sama tercatat dua kali saat "Catat konsumsi dari pick
 * list" diulang setelah kegagalan sebagian (lihat consumeFromPick). */
export async function consumedHuIds(batchId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('batch_consumption')
    .select('hu_id')
    .eq('batch_id', batchId)
    .not('hu_id', 'is', null);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.hu_id as string));
}

/**
 * Konsumsi bahan ke batch. Trigger database menolak lot kedaluwarsa,
 * halal habis, belum release, atau melanggar FEFO tanpa alasan tertulis.
 */
export async function consumeLot(input: ConsumeInput) {
  const { data, error } = await supabase
    .from('batch_consumption')
    .insert({
      batch_id: input.batchId,
      lot_id: input.lotId,
      item_id: input.itemId,
      hu_id: input.huId ?? null,
      qty_planned: input.qtyPlanned ?? null,
      qty_actual: input.qtyActual,
      uom: input.uom,
      fefo_override: input.fefoOverride ?? false,
      override_reason: input.overrideReason ?? null,
    })
    .select('id, unit_cost, line_cost')
    .single();
  if (error) throw parseDbError(error);

  // kurangi sisa handling unit lewat buku besar pergerakan
  if (input.huId) {
    await supabase.from('stock_movements').insert({
      type: 'ISSUE',
      item_id: input.itemId,
      lot_id: input.lotId,
      hu_id: input.huId,
      qty: -Math.abs(input.qtyActual),
      uom: input.uom,
      doc_type: 'BATCH',
      doc_id: input.batchId,
    });
  }
  return data;
}

export async function recordCcp(
  batchId: string,
  ccpId: string,
  value: { value_num?: number; value_text?: string; corrective_action?: string }
) {
  const { data, error } = await supabase
    .from('ccp_readings')
    .insert({ batch_id: batchId, ccp_id: ccpId, ...value })
    .select('id, result')
    .single();
  if (error) throw parseDbError(error);
  return data;
}

export interface CreateBatchInput {
  itemId: string;
  formulaId: string;
  targetQty: number;
  customerId?: string;
  lineCode?: string;
  remarks?: string;
}

/** Rencanakan batch baru berstatus PLANNED, siap digelombangkan atau diterbitkan pick list-nya. */
export async function createBatch(input: CreateBatchInput) {
  const { data: batchNo, error: e1 } = await supabase.rpc('next_doc_no', { p_prefix: 'BTC' });
  if (e1) throw parseDbError(e1);

  const { data, error: e2 } = await supabase
    .from('production_batches')
    .insert({
      batch_no: batchNo,
      item_id: input.itemId,
      formula_id: input.formulaId,
      target_qty: input.targetQty,
      customer_id: input.customerId || null,
      line_code: input.lineCode || null,
      remarks: input.remarks || null,
    })
    .select('id, batch_no')
    .single();
  if (e2) throw parseDbError(e2);
  return data;
}

export interface CloseBatchInput {
  batchId: string;
  actualQty: number;
  rejectQty: number;
  itemId: string;
  shelfLifeDays?: number;
  locationId?: string;
}

/** Tutup batch: buat lot produk jadi, catat hasil, kembalikan yield & HPP. */
export async function closeBatch(input: CloseBatchInput) {
  const { data: lotCode, error: e1 } = await supabase.rpc('next_doc_no', { p_prefix: 'LOT' });
  if (e1) throw e1;

  const expiry = input.shelfLifeDays
    ? new Date(Date.now() + input.shelfLifeDays * 86400000).toISOString().slice(0, 10)
    : null;

  const { data: outLot, error: e2 } = await supabase
    .from('lots')
    .insert({
      lot_code: lotCode,
      item_id: input.itemId,
      production_batch_id: input.batchId,
      manufactured_on: new Date().toISOString().slice(0, 10),
      expiry_date: expiry,
      qty_received: input.actualQty,
      status: 'QUARANTINE',       // produk jadi juga menunggu release QA
    })
    .select('id')
    .single();
  if (e2) throw e2;

  const { error: e3 } = await supabase
    .from('production_batches')
    .update({
      actual_qty: input.actualQty,
      reject_qty: input.rejectQty,
      output_lot_id: outLot.id,
      closed_at: new Date().toISOString(),
      status: 'CLOSED',
    })
    .eq('id', input.batchId);
  if (e3) throw e3;

  await supabase.from('stock_movements').insert({
    type: 'PRODUCTION_IN',
    item_id: input.itemId,
    lot_id: outLot.id,
    qty: input.actualQty,
    uom: 'KG',
    to_location_id: input.locationId ?? null,
    doc_type: 'BATCH',
    doc_id: input.batchId,
  });

  const { data: cost, error: e4 } = await supabase
    .from('v_batch_cost')
    .select('*')
    .eq('batch_id', input.batchId)
    .single();
  if (e4) throw e4;
  return cost;
}

/* -------------------------------------------------------------- telusur */

export async function traceForward(lotId: string) {
  const { data, error } = await supabase
    .from('v_trace_forward')
    .select('*')
    .eq('source_lot_id', lotId);
  if (error) throw error;
  return data;
}

export async function traceBackward(batchId: string) {
  const { data, error } = await supabase
    .from('batch_consumption')
    // partners!lots_supplier_id_fkey wajib eksplisit — lots punya DUA FK ke
    // partners (supplier_id, owner_partner_id), PostgREST menolak menebak
    .select('qty_actual, uom, lots(lot_code, expiry_date, supplier_id, partners!lots_supplier_id_fkey(name)), items(name)')
    .eq('batch_id', batchId);
  if (error) throw error;
  return data;
}

export async function consignmentBalance(customerId?: string) {
  let q = supabase.from('v_consignment_balance').select('*');
  if (customerId) q = q.eq('customer_id', customerId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/* --------------------------------------------------------- notifikasi */

export async function openNotifications() {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

export function subscribeNotifications(cb: (row: Record<string, unknown>) => void) {
  // Topik unik per pemanggilan — App.tsx (badge global) dan Notifications.tsx
  // (daftar layar) berlangganan bersamaan; topik sama ('notif') membuat
  // panggilan .on() kedua gagal karena channel pertama sudah ter-subscribe.
  return supabase
    .channel(`notif-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' },
        (p) => cb(p.new as Record<string, unknown>))
    .subscribe();
}
