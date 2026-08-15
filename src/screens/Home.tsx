import { Link } from 'react-router-dom';
import { C, MONO, s } from '../ui';

interface Props { unread: number; queued: number; role?: string }

const TILES = [
  { to: '/pindai', title: 'Pindai label', hint: 'Cek isi kemasan, kedaluwarsa, status QC' },
  { to: '/terima', title: 'Terima bahan', hint: 'GRN + cetak label QR per kemasan' },
  { to: '/qc', title: 'QC hold', hint: 'Sampel, hasil uji, release lot' },
  { to: '/produksi', title: 'Produksi', hint: 'Batch, saran FEFO, CCP, tutup batch' },
  { to: '/telusur', title: 'Telusur', hint: 'Dua arah: lot → produk, batch → bahan' },
];

export default function Home({ unread, queued }: Props) {
  return (
    <div style={s.page}>
      <h1 style={s.h1}>Beranda</h1>
      <p style={s.sub}>Fase 1 · lot, QR, FEFO, QC hold, peringatan kedaluwarsa</p>

      {queued > 0 && (
        <div style={{ ...s.card, borderTop: `3px solid ${C.amber}` }}>
          <div style={s.code}>{queued} pencatatan menunggu sinyal</div>
          <div style={s.meta}>Tersimpan di HP. Terkirim otomatis saat jaringan kembali.</div>
        </div>
      )}

      {unread > 0 && (
        <Link to="/notifikasi" style={{ textDecoration: 'none' }}>
          <div style={{ ...s.card, borderTop: `3px solid ${C.chili}` }}>
            <div style={{ ...s.code, color: C.chili }}>{unread} peringatan belum dibaca</div>
            <div style={s.meta}>Kedaluwarsa · sertifikat halal · pelanggaran FEFO</div>
          </div>
        </Link>
      )}

      <div style={s.secHead}>Pekerjaan</div>
      {TILES.map((t) => (
        <Link key={t.to} to={t.to} style={{ textDecoration: 'none' }}>
          <div style={{ ...s.card, ...s.rowBetween }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{t.title}</div>
              <div style={s.meta}>{t.hint}</div>
            </div>
            <span style={{ color: C.neo, fontFamily: MONO, fontSize: 16 }}>›</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
