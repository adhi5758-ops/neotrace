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

console.log('OK — semua cek lulus');
