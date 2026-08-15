/**
 * Hub gudang. Fase 1 punya satu pintu (Terima); Fase 2 menambah put-away,
 * picking, dan staging — terlalu banyak untuk navigasi bawah, jadi dikumpulkan
 * di sini dengan jumlah tugas terbuka langsung terlihat.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { openPutawayCount } from '../lib/putaway';
import { openPickCount } from '../lib/picking';
import { C, MONO, s } from '../ui';

export default function Warehouse() {
  const [putaway, setPutaway] = useState<number | null>(null);
  const [picks, setPicks] = useState<number | null>(null);

  useEffect(() => {
    void openPutawayCount().then(setPutaway).catch(() => setPutaway(null));
    void openPickCount().then(setPicks).catch(() => setPicks(null));
  }, []);

  const tiles = [
    { to: '/terima', title: 'Terima bahan', hint: 'GRN + cetak label QR per kemasan', badge: null },
    { to: '/putaway', title: 'Put-away', hint: 'Letakkan kemasan ke rak, zonasi alergen dikunci', badge: putaway },
    { to: '/picking', title: 'Pick list', hint: 'Ambil bahan urut jalur gudang, konfirmasi scan', badge: picks },
    { to: '/gelombang', title: 'Gelombang', hint: 'Wave picking: banyak batch, satu jalan, tote per batch', badge: null },
    { to: '/staging', title: 'Staging', hint: 'Satu area satu batch, papan okupansi lini', badge: null },
    { to: '/konsol', title: 'Konsol gudang', hint: 'Peta rak, dock-to-stock, kinerja picking', badge: null },
  ];

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Gudang</h1>
      <p style={s.sub}>Put-away terarah · zonasi alergen · picking · gelombang · staging</p>

      {tiles.map((t) => (
        <Link key={t.to} to={t.to} style={{ textDecoration: 'none' }}>
          <div style={{ ...s.card, ...s.rowBetween }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{t.title}</div>
              <div style={s.meta}>{t.hint}</div>
            </div>
            {t.badge != null && t.badge > 0
              ? <span style={{ ...s.code, color: C.amber, fontSize: 15 }}>{t.badge}</span>
              : <span style={{ color: C.neo, fontFamily: MONO, fontSize: 16 }}>›</span>}
          </div>
        </Link>
      ))}
    </div>
  );
}
