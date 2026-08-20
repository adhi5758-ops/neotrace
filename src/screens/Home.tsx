import { Link } from 'react-router-dom';
import { C, MONO, s } from '../ui';

interface Props { unread: number; queued: number; role?: string }

const TILES = [
  { to: '/pindai', title: 'Pindai label', hint: 'Cek isi kemasan, kedaluwarsa, status QC' },
  { to: '/gudang', title: 'Gudang', hint: 'Terima, put-away, picking, staging' },
  { to: '/qc', title: 'QC hold', hint: 'Sampel, hasil uji, release lot' },
  { to: '/produksi', title: 'Produksi', hint: 'Batch, pick list, saran FEFO, CCP, HPP' },
  { to: '/pengiriman', title: 'Pengiriman', hint: 'Delivery order, pick outbound, tandai terkirim' },
  { to: '/telusur', title: 'Telusur', hint: 'Dua arah: lot → produk, batch → bahan' },
  { to: '/analitik', title: 'Analitik', hint: 'Perputaran, KPI, peramalan, sinkronisasi ERP' },
  { to: '/opname', title: 'Stock opname', hint: 'Rencana hitung, submit hasil, approve/reject QA' },
  { to: '/replenishment', title: 'Replenishment', hint: 'Rak primer di bawah stok minimum, saran isi ulang' },
];

export default function Home({ unread, queued, role }: Props) {
  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Beranda</h1>
      <p style={s.sub}>Fase 2 · put-away terarah, zonasi alergen, pick list, staging</p>

      {(queued > 0 || unread > 0) && (
        <div style={s.cardGrid}>
          {queued > 0 && (
            <div style={{ ...s.card, marginBottom: 0, borderTop: `3px solid ${C.amber}` }}>
              <div style={s.code}>{queued} pencatatan menunggu sinyal</div>
              <div style={s.meta}>Tersimpan di HP. Terkirim otomatis saat jaringan kembali.</div>
            </div>
          )}

          {unread > 0 && (
            <Link to="/notifikasi" style={{ textDecoration: 'none' }}>
              <div style={{ ...s.card, marginBottom: 0, borderTop: `3px solid ${C.chili}` }}>
                <div style={{ ...s.code, color: C.chili }}>{unread} peringatan belum dibaca</div>
                <div style={s.meta}>Kedaluwarsa · sertifikat halal · pelanggaran FEFO</div>
              </div>
            </Link>
          )}
        </div>
      )}

      <div style={s.secHead}>Pekerjaan</div>
      <div style={s.cardGrid}>
        {TILES.map((t) => (
          <Link key={t.to} to={t.to} style={{ textDecoration: 'none' }}>
            <div style={{ ...s.card, ...s.rowBetween, marginBottom: 0 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{t.title}</div>
                <div style={s.meta}>{t.hint}</div>
              </div>
              <span style={{ color: C.neo, fontFamily: MONO, fontSize: 16 }}>›</span>
            </div>
          </Link>
        ))}

        {role === 'ADMIN' && (
          <Link to="/admin" style={{ textDecoration: 'none' }}>
            <div style={{ ...s.card, ...s.rowBetween, marginBottom: 0, borderTop: `3px solid ${C.ink}` }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>Administrator</div>
                <div style={s.meta}>Pengguna · hak akses WMS · data induk</div>
              </div>
              <span style={{ color: C.neo, fontFamily: MONO, fontSize: 16 }}>›</span>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}
