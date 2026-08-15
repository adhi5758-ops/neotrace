/**
 * NEOTRACE — cetak label QR per handling unit.
 *
 * Label dicetak lewat jendela browser ke printer thermal (ukuran default
 * 50 × 30 mm, stiker gulung). Isi QR memakai URL penuh supaya HP tanpa
 * aplikasi pun mengarah ke aplikasi; extractToken() di api.ts yang
 * menariknya kembali jadi UUID.
 */
import QRCode from 'qrcode';

export const LABEL_MM = { w: 50, h: 30 };

export interface LabelData {
  hu_code: string;
  qr_token: string;
  lot_code: string;
  item_name: string;
  qty: number;
  uom: string;
  expiry_date?: string | null;
  owner_name?: string | null;   // diisi kalau bahan titipan klien
}

export const tokenUrl = (token: string, origin = window.location.origin) =>
  `${origin}/h/${token}`;

async function labelHtml(d: LabelData): Promise<string> {
  const png = await QRCode.toDataURL(tokenUrl(d.qr_token), { margin: 0, width: 220 });
  const esc = (v: unknown) =>
    String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  return `
  <div class="lbl">
    <img src="${png}" alt="" />
    <div class="txt">
      <div class="hu">${esc(d.hu_code)}</div>
      <div class="item">${esc(d.item_name)}</div>
      <div class="kv">LOT ${esc(d.lot_code)}</div>
      <div class="kv">${esc(d.qty)} ${esc(d.uom)}</div>
      <div class="kv">EXP ${esc(d.expiry_date ?? '-')}</div>
      ${d.owner_name ? `<div class="own">TITIPAN · ${esc(d.owner_name)}</div>` : ''}
    </div>
  </div>`;
}

/** Buka jendela cetak berisi seluruh label. Satu label per halaman stiker. */
export async function printLabels(labels: LabelData[]) {
  if (!labels.length) return;
  const body = (await Promise.all(labels.map(labelHtml))).join('');
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) throw new Error('Popup diblokir browser — izinkan popup untuk mencetak label.');

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Label NEOTRACE</title>
  <style>
    @page { size: ${LABEL_MM.w}mm ${LABEL_MM.h}mm; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-monospace, "Cascadia Mono", "DejaVu Sans Mono", monospace; color: #000; }
    .lbl { width: ${LABEL_MM.w}mm; height: ${LABEL_MM.h}mm; padding: 1.5mm;
           display: flex; gap: 1.5mm; align-items: center; page-break-after: always; }
    .lbl img { width: 24mm; height: 24mm; flex: none; }
    .txt { min-width: 0; line-height: 1.25; }
    .hu { font-size: 8pt; font-weight: 700; letter-spacing: .02em; }
    .item { font-size: 6pt; margin: .4mm 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kv { font-size: 6pt; }
    .own { font-size: 5.5pt; margin-top: .4mm; border: .3mm solid #000; padding: 0 .6mm; display: inline-block; }
    @media screen { body { background: #EEF3F0; padding: 8px; } .lbl { background: #fff; margin-bottom: 6px; border: 1px solid #CFDAD4; } }
  </style></head><body>${body}
  <script>window.onload = function () { window.print(); };<\/script>
  </body></html>`);
  w.document.close();
}
