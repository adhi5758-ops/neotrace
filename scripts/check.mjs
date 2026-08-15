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

console.log('OK — semua cek lulus');
