/**
 * NEOTRACE — baca/tulis Excel untuk unggah data induk massal.
 * Pakai SheetJS (xlsx) di browser — semua parsing terjadi di sisi klien,
 * tidak ada file yang singgah di server mana pun.
 *
 * xlsx diimpor dinamis (bukan di atas file) karena ukurannya besar dan hanya
 * dipakai di layar Administrator — operator lantai produksi yang cuma
 * memindai QR tidak perlu memuatnya sama sekali.
 */

/** Baca file Excel/CSV jadi array baris — baris pertama jadi nama kolom. */
export async function parseExcelFile(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

/** Unduh templat: baris header + satu baris contoh, supaya format kolom jelas. */
export async function downloadTemplate(
  filename: string,
  headers: string[],
  example: (string | number | boolean | null)[]
) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, filename);
}
