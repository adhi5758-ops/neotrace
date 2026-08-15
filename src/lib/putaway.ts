/**
 * NEOTRACE Fase 2 — put-away terarah & zonasi alergen (P13).
 *
 * Aturan zonasi ditegakkan trigger `t_hu_location_guard` di database, bukan di
 * sini. Layer ini hanya menyiapkan panggilan dan menerjemahkan penolakannya
 * jadi kalimat yang bisa dibaca petugas gudang.
 */
import { supabase, parseDbError } from './api';

/* ------------------------------------------------------------------ tipe */

export type ZoneErrorCode =
  | 'ZONE_POLICY' | 'ALLERGEN_ABOVE' | 'NON_ALLERGEN_BELOW'
  | 'LOCATION_NOT_FOUND' | 'REASON_REQUIRED' | 'TASK_ALREADY_DONE';

/** Kalimat operator untuk penolakan zonasi. Pesan detail dari DB ikut ditampilkan. */
export const ZONE_MESSAGES: Record<ZoneErrorCode, { title: string; hint: string }> = {
  ZONE_POLICY:        { title: 'Rak salah kategori',        hint: 'Rak ini khusus kategori lain. Pakai rak yang sesuai.' },
  ALLERGEN_ABOVE:     { title: 'Ada alergen di atas',       hint: 'Bahan non-alergen tidak boleh di bawah alergen. Pilih rak lain.' },
  NON_ALLERGEN_BELOW: { title: 'Ada non-alergen di bawah',  hint: 'Bahan alergen tidak boleh di atas non-alergen. Pakai rak alergen.' },
  LOCATION_NOT_FOUND: { title: 'Lokasi tidak dikenali',     hint: 'Label rak rusak atau salah ketik. Cek kode rak.' },
  REASON_REQUIRED:    { title: 'Alasan wajib diisi',        hint: 'Lokasi berbeda dari saran sistem — tulis alasannya.' },
  TASK_ALREADY_DONE:  { title: 'Tugas sudah selesai',       hint: 'Kemasan ini sudah diletakkan. Muat ulang daftar.' },
};

export interface PutawaySuggestion {
  location_id: string;
  location_code: string;
  score: number;
  reason: string;
}

export interface PutawayTask {
  id: string;
  doc_no: string;
  hu_id: string;
  status: 'OPEN' | 'ASSIGNED' | 'DONE' | 'CANCELLED';
  suggested_location_id: string | null;
  actual_location_id: string | null;
  created_at: string;
  handling_units: {
    hu_code: string; qty_remaining: number; uom: string; location_id: string | null;
    lots: { lot_code: string; expiry_date: string | null; items: { name: string; code: string } | null } | null;
  } | null;
}

/* ------------------------------------------------------------- kode lokasi */

/**
 * Ambil kode rak dari QR lokasi (`/l/A1-L1-01`) atau ketikan manual.
 * Menolak QR kemasan — token kemasan berupa UUID, dan salah pindai antara
 * kemasan dan rak adalah kesalahan paling mudah terjadi di alur scan ganda.
 */
export function extractLocationCode(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) return null;
  const url = t.match(/\/l\/([A-Za-z0-9._-]+)\/?$/);
  const code = url ? url[1] : t;
  return /^[A-Za-z0-9._-]{2,40}$/.test(code) ? code.toUpperCase() : null;
}

/* -------------------------------------------------------------- kueri */

export async function listPutawayTasks(onlyOpen = true): Promise<PutawayTask[]> {
  let q = supabase
    .from('putaway_tasks')
    .select('id, doc_no, hu_id, status, suggested_location_id, actual_location_id, created_at, handling_units(hu_code, qty_remaining, uom, location_id, lots(lot_code, expiry_date, items(name, code)))')
    .order('created_at');
  if (onlyOpen) q = q.in('status', ['OPEN', 'ASSIGNED']);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as PutawayTask[];
}

export async function openPutawayCount(): Promise<number> {
  const { count, error } = await supabase
    .from('putaway_tasks')
    .select('id', { count: 'exact', head: true })
    .in('status', ['OPEN', 'ASSIGNED']);
  if (error) throw error;
  return count ?? 0;
}

/** resolve_qr mengembalikan nama & kode item, bukan id — saran put-away butuh id. */
export async function itemIdForLot(lotId: string): Promise<string | null> {
  const { data, error } = await supabase.from('lots').select('item_id').eq('id', lotId).maybeSingle();
  if (error) throw error;
  return (data as { item_id: string } | null)?.item_id ?? null;
}

export async function suggestPutaway(itemId: string, qty: number): Promise<PutawaySuggestion[]> {
  const { data, error } = await supabase.rpc('suggest_putaway', { p_item_id: itemId, p_qty: qty });
  if (error) throw error;
  return (data ?? []) as PutawaySuggestion[];
}

/** Selesaikan tugas. Lokasi beda dari saran → alasan minimal 8 karakter (dicek DB juga). */
export async function completePutaway(taskId: string, actualLocationId: string, reason?: string) {
  const { error } = await supabase.rpc('complete_putaway', {
    p_task_id: taskId,
    p_actual_location_id: actualLocationId,
    p_reason: reason?.trim() || null,
  });
  if (error) throw parseDbError(error);
}

/** Terbitkan tugas manual (normalnya trigger yang melakukan ini saat QA release). */
export async function createPutawayTasks(lotId: string, receiptId?: string): Promise<number> {
  const { data, error } = await supabase.rpc('create_putaway_tasks', {
    p_lot_id: lotId,
    p_receipt_id: receiptId ?? null,
  });
  if (error) throw parseDbError(error);
  return data as number;
}

/**
 * Pemindahan stok bebas tanpa tugas (P09). Sengaja memakai jalur yang sama
 * dengan put-away: update location_id → trigger zonasi yang memutuskan.
 */
export async function transferHu(huId: string, toLocationId: string) {
  const { error } = await supabase
    .from('handling_units')
    .update({ location_id: toLocationId })
    .eq('id', huId);
  if (error) throw parseDbError(error);
}

/** Cek zona sebelum operator berjalan ke rak — tanpa mengubah apa pun. */
export async function checkZoning(itemId: string, locationId: string, huId?: string) {
  const { error } = await supabase.rpc('assert_allergen_zoning', {
    p_item_id: itemId,
    p_location_id: locationId,
    p_hu_id: huId ?? null,
  });
  if (error) throw parseDbError(error);
}
