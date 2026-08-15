/**
 * Cek mandiri logika non-UI. Jalankan: npm run check
 * Sengaja tanpa framework tes — ini pagar, bukan suite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* --- extractToken & parseDbError: disalin dari src/lib/api.ts (murni) --- */
const src = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

function extractToken(raw) {
  const m = raw.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}
function parseDbError(e) {
  const raw = e?.message ?? String(e);
  const m = raw.match(/^([A-Z_]+):\s*(.*)$/);
  if (m) return { code: m[1], message: m[2] };
  if (/duplicate key/i.test(raw)) return { code: 'DUPLICATE', message: 'Data sudah pernah dicatat.' };
  return { code: 'UNKNOWN', message: raw };
}

// pagar: kalau implementasi di api.ts berubah, cek ini ikut wajib diperbarui
assert.ok(src.includes('export function extractToken'), 'extractToken hilang dari api.ts');
assert.ok(src.includes('export function parseDbError'), 'parseDbError hilang dari api.ts');

const UUID = '2f1c9b7e-4a3d-4f21-9c88-7b5e0a1d6c42';
assert.equal(extractToken(UUID), UUID, 'UUID telanjang');
assert.equal(extractToken(` https://neotrace.app/h/${UUID} `), UUID, 'UUID dari URL label');
assert.equal(extractToken('LABEL-RUSAK-123'), null, 'kode acak ditolak');

assert.deepEqual(
  parseDbError(new Error('FEFO_VIOLATION: masih ada lot lebih dekat kedaluwarsa — LOT-1')),
  { code: 'FEFO_VIOLATION', message: 'masih ada lot lebih dekat kedaluwarsa — LOT-1' }
);
assert.equal(parseDbError(new Error('duplicate key value violates ...')).code, 'DUPLICATE');
assert.equal(parseDbError(new Error('connection refused')).code, 'UNKNOWN');

/* --- pembagian qty ke handling unit (receiveGoods) --- */
const perHu = (qty, huCount) => qty / Math.max(1, Math.floor(huCount || 1));
assert.equal(perHu(1000, 4), 250, 'pembagian rata');
assert.equal(perHu(1000, 0) , 1000, 'huCount 0 dianggap 1 — jangan Infinity');
assert.ok(Math.abs(perHu(100, 3) * 3 - 100) < 1e-9, 'total kemasan = total lot');

/* --- syarat FEFO override: alasan minimal 8 karakter (BatchConsumePanel) --- */
const canOverride = (reason) => reason.trim().length >= 8;
assert.equal(canOverride('   '), false, 'alasan kosong ditolak');
assert.equal(canOverride('macet'), false, 'alasan terlalu pendek ditolak');
assert.equal(canOverride('rak belakang terkunci'), true);

/* --- error permanen tidak diulang selamanya (offlineQueue.flush) --- */
const isPermanent = (m) => /LOT_EXPIRED|HALAL_EXPIRED|LOT_NOT_RELEASED|FEFO_VIOLATION|duplicate key/i.test(m);
assert.equal(isPermanent('LOT_EXPIRED: bahan kedaluwarsa'), true);
assert.equal(isPermanent('Failed to fetch'), false, 'gangguan jaringan harus diulang');

/* ================= FASE 2 ================= */

const p2 = readFileSync(new URL('../src/lib/putaway.ts', import.meta.url), 'utf8');
assert.ok(p2.includes('export function extractLocationCode'), 'extractLocationCode hilang dari putaway.ts');

/* --- kode rak dari QR lokasi: harus menolak QR kemasan --- */
function extractLocationCode(raw) {
  const t = raw.trim();
  if (!t) return null;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) return null;
  const url = t.match(/\/l\/([A-Za-z0-9._-]+)\/?$/);
  const code = url ? url[1] : t;
  return /^[A-Za-z0-9._-]{2,40}$/.test(code) ? code.toUpperCase() : null;
}

assert.equal(extractLocationCode('https://neotrace.app/l/A1-L1-01'), 'A1-L1-01', 'kode rak dari URL');
assert.equal(extractLocationCode(' a2-l2-01 '), 'A2-L2-01', 'ketikan manual jadi huruf besar');
assert.equal(extractLocationCode('STG-L1'), 'STG-L1');
// paling penting: label kemasan dipindai saat diminta label rak
assert.equal(extractLocationCode(`https://neotrace.app/h/${UUID}`), null, 'QR kemasan ditolak sebagai lokasi');
assert.equal(extractLocationCode(UUID), null, 'UUID telanjang ditolak sebagai lokasi');
assert.equal(extractLocationCode('rak sebelah pintu'), null, 'teks bebas ditolak');

/* --- put-away menyimpang dari saran: alasan wajib (cermin complete_putaway) --- */
const putawayOk = (suggestedId, actualId, reason) =>
  suggestedId === actualId || (reason ?? '').trim().length >= 8;
assert.equal(putawayOk('L1', 'L1', ''), true, 'sesuai saran tanpa alasan boleh');
assert.equal(putawayOk('L1', 'L2', 'penuh'), false, 'alasan terlalu pendek ditolak');
assert.equal(putawayOk('L1', 'L2', 'rak saran penuh lot lain'), true);
assert.equal(putawayOk(null, 'L2', ''), false, 'tanpa saran tetap butuh alasan');

/* --- short pick: qty kurang → SHORT, bukan gagal (cermin confirm_pick) --- */
const pickStatus = (requested, picked) => (picked >= requested ? 'COMPLETED' : 'SHORT');
assert.equal(pickStatus(50, 50), 'COMPLETED');
assert.equal(pickStatus(50, 12), 'SHORT', 'kurang dari permintaan harus tercatat SHORT');
assert.equal(pickStatus(50, 60), 'COMPLETED', 'lebih dari permintaan tetap selesai');

/* --- skala formula → pick list, termasuk scrap (cermin generate_pick_list) --- */
const qtyNeeded = (lineQty, targetQty, outputQty, scrapPct) =>
  +(lineQty * (targetQty / outputQty) * (1 + scrapPct / 100)).toFixed(4);
assert.equal(qtyNeeded(10, 500, 100, 0), 50, 'skala 5x tanpa scrap');
assert.equal(qtyNeeded(10, 500, 100, 2), 51, 'scrap 2% ikut terhitung');
assert.equal(qtyNeeded(2.5, 100, 100, 0), 2.5, 'skala 1:1');

/* ================= FASE 3 ================= */

const p3 = readFileSync(new URL('../src/lib/labour.ts', import.meta.url), 'utf8');
assert.ok(p3.includes('export function isStaleSession'), 'isStaleSession hilang dari labour.ts');
assert.ok(p3.includes('STALE_SESSION_HOURS = 8'), 'ambang sesi basi berubah — perbarui cek ini');

/* --- sesi menggantung: satu shift penuh dianggap basi --- */
const HOUR = 3_600_000;
const sessionAgeHours = (startedAt, now) => (now - new Date(startedAt).getTime()) / HOUR;
const isStaleSession = (startedAt, now) => sessionAgeHours(startedAt, now) >= 8;

const NOW = Date.parse('2027-01-20T15:00:00Z');
assert.equal(isStaleSession(new Date(NOW - 2 * HOUR).toISOString(), NOW), false, 'sesi 2 jam masih wajar');
assert.equal(isStaleSession(new Date(NOW - 9 * HOUR).toISOString(), NOW), true, 'sesi 9 jam menggantung');
assert.equal(isStaleSession(new Date(NOW - 8 * HOUR).toISOString(), NOW), true, 'tepat 8 jam sudah basi');

/* --- kode tote per batch dalam satu gelombang (cermin generate_wave) --- */
const toteFor = (index) => `TOTE-${String(index + 1).padStart(2, '0')}`;
assert.equal(toteFor(0), 'TOTE-01');
assert.equal(toteFor(9), 'TOTE-10');
// tote wajib unik per batch — bahan tertukar di troli adalah RAID R33
const totes = [0, 1, 2, 3].map(toteFor);
assert.equal(new Set(totes).size, totes.length, 'kode tote harus unik dalam satu gelombang');

/* ================= FASE 4 ================= */

const p4 = readFileSync(new URL('../src/lib/api-phase4.ts', import.meta.url), 'utf8');
assert.ok(p4.includes('MIN_PERIODS_FOR_REORDER = 12'), 'ambang periode reorder berubah — perbarui cek ini');
// idempotency_key tidak boleh disentuh saat antre ulang, itu penjaga anti-dokumen-ganda
assert.ok(!/update\([^)]*idempotency_key/s.test(p4), 'requeue tidak boleh mengubah idempotency_key');

/* --- R44: saran reorder disembunyikan bila data historis belum cukup --- */
const showReorder = (periods) => periods >= 12;
assert.equal(showReorder(3), false, 'data 3 periode belum boleh jadi angka perencanaan');
assert.equal(showReorder(11), false);
assert.equal(showReorder(12), true, '12 periode penuh baru boleh dipakai');

/* --- titik pesan & kebutuhan reorder (cermin v_reorder_suggestions) --- */
const reorderLevel = (forecastQty, leadDays, safety) =>
  +((forecastQty / 30) * leadDays + (safety ?? 0)).toFixed(2);
assert.equal(reorderLevel(300, 7, 20), 90, 'ramalan 300/bulan, lead 7 hari, safety 20');
assert.equal(reorderLevel(0, 7, 15), 15, 'tanpa ramalan, titik pesan = safety stock');
const needsReorder = (onHand, level) => onHand <= level;
assert.equal(needsReorder(90, 90), true, 'tepat di titik pesan harus memicu');
assert.equal(needsReorder(91, 90), false);

console.log('OK — semua cek lulus');
