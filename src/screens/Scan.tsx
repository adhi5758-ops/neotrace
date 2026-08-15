/**
 * Layar pindai bebas (LOOKUP). Dipakai untuk mengecek isi kemasan tanpa
 * mengubah data — juga menjadi tujuan saat QR dibuka lewat kamera bawaan HP
 * (rute /h/:token).
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import QrScanner from '../components/QrScanner';
import { resolveQr, type ScanResult, SCAN_MESSAGES, type ScanErrorCode } from '../lib/api';
import { C, MONO, s, pill, lotTone } from '../ui';

export default function Scan() {
  const { token } = useParams();
  const [open, setOpen] = useState(!token);
  const [last, setLast] = useState<ScanResult | null>(null);

  useEffect(() => {
    if (token) void resolveQr(token, 'LOOKUP').then(setLast).catch(() => setLast({ ok: false, error: 'OFFLINE' }));
  }, [token]);

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Pindai label</h1>
      <p style={s.sub}>Hanya melihat isi — tidak mengubah stok</p>

      <button style={s.btn} onClick={() => setOpen(true)}>Buka kamera</button>

      {last && <ScanCard r={last} />}

      {open && (
        <QrScanner
          action="LOOKUP"
          title="Cek kemasan"
          onAccept={(r) => { setLast(r); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ScanCard({ r }: { r: ScanResult }) {
  if (!r.ok) {
    const m = SCAN_MESSAGES[(r.error ?? 'NOT_FOUND') as ScanErrorCode];
    return (
      <div style={{ ...s.card, borderTop: `3px solid ${C.chili}`, marginTop: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.chili }}>{m.title}</div>
        <div style={s.meta}>{m.hint}</div>
        {r.lot_code && <div style={{ ...s.meta, marginTop: 8 }}>LOT {r.lot_code} · exp {r.expiry_date ?? '—'}</div>}
      </div>
    );
  }
  return (
    <div style={{ ...s.card, borderTop: `3px solid ${C.neo}`, marginTop: 18 }}>
      <div style={s.rowBetween}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{r.item_name}</div>
        <span style={pill(lotTone(r.lot_status))}>{r.lot_status}</span>
      </div>
      <dl style={kv}>
        <dt>Lot</dt><dd>{r.lot_code}</dd>
        <dt>Kemasan</dt><dd>{r.hu_code}</dd>
        <dt>Sisa</dt><dd>{r.qty_remaining} {r.uom}</dd>
        <dt>Kedaluwarsa</dt><dd>{r.expiry_date ?? '—'}</dd>
        <dt>Halal s/d</dt><dd>{r.halal_valid_until ?? '—'}</dd>
        <dt>Lokasi</dt><dd>{r.location_code ?? '—'}</dd>
        {r.owner_type === 'CONSIGNED' && (<><dt>Pemilik</dt><dd style={{ color: C.amber }}>Titipan · {r.owner_name}</dd></>)}
        {!!r.allergens?.length && (<><dt>Alergen</dt><dd style={{ color: C.amber }}>{r.allergens.join(', ')}</dd></>)}
      </dl>
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
  fontSize: 12.5, fontFamily: MONO, margin: '12px 0 0',
};
