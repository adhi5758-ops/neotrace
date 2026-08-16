/**
 * NEOTRACE — konfigurasi data induk yang bisa dikelola lewat unggah Excel.
 * Tabelnya sudah ada sejak v1/Fase 2 (items, partners, locations) — di sini
 * hanya memetakan kolom templat & kolom boolean yang perlu dikonversi dari
 * teks ('true'/'false') saat dibaca dari Excel.
 */
export interface MasterTableConfig {
  key: string;
  label: string;
  table: string;
  conflictKey: string;
  headers: string[];
  example: (string | number | null)[];
  booleanColumns: string[];
}

export const MASTER_TABLES: MasterTableConfig[] = [
  {
    key: 'items',
    label: 'Bahan & produk (Items)',
    table: 'items',
    conflictKey: 'code',
    headers: ['code', 'name', 'type', 'base_uom', 'shelf_life_days', 'standard_cost', 'requires_halal_cert'],
    example: ['RM-XXX-001', 'Contoh Bahan Baku', 'RAW', 'KG', null, 15000, 'true'],
    booleanColumns: ['requires_halal_cert'],
  },
  {
    key: 'partners',
    label: 'Mitra (supplier/klien)',
    table: 'partners',
    conflictKey: 'code',
    headers: ['code', 'name', 'type', 'npwp', 'address', 'contact_name', 'contact_phone', 'halal_cert_no', 'halal_valid_until'],
    example: ['SUP-XXX', 'Contoh Supplier', 'SUPPLIER', null, null, null, null, null, null],
    booleanColumns: [],
  },
  {
    key: 'locations',
    label: 'Lokasi & rak',
    table: 'locations',
    conflictKey: 'code',
    headers: ['code', 'name', 'type', 'rack_code', 'level_no', 'position_no', 'max_weight_kg', 'max_hu_count', 'allergen_policy', 'pick_sequence', 'is_staging'],
    example: ['A3-L1-01', 'Rak A3 Level 1 Pos 1', 'RAW', 'A3', 1, 1, 1200, 8, 'MIXED', 50, 'false'],
    booleanColumns: ['is_staging'],
  },
];

/** Ubah baris hasil parse Excel (semua teks/angka mentah) jadi siap-upsert. */
export function coerceRow(row: Record<string, unknown>, cfg: MasterTableConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of cfg.headers) {
    const raw = row[key];
    if (raw === undefined || raw === '') {
      out[key] = null;
    } else if (cfg.booleanColumns.includes(key)) {
      out[key] = String(raw).trim().toLowerCase() === 'true' || raw === true || raw === 1;
    } else {
      out[key] = raw;
    }
  }
  return out;
}
