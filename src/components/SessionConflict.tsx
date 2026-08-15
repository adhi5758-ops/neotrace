/**
 * Sesi kerja lain masih terbuka (W10).
 *
 * Muncul saat operator membuka tugas baru sementara sesi lama belum tertutup —
 * biasanya karena HP mati atau browser ditutup paksa. Ditampilkan sebagai
 * pilihan, bukan blokir: pekerjaan di lantai tidak boleh berhenti karena
 * pencatatan waktu.
 */
import { useState } from 'react';
import { isStaleSession, sessionAgeHours, type OpenSessionRow } from '../lib/labour';
import { C, MONO, s, pill } from '../ui';

type Props = {
  session: OpenSessionRow;
  onResolve: () => Promise<void>;
};

export default function SessionConflict({ session, onResolve }: Props) {
  const [busy, setBusy] = useState(false);
  const hours = sessionAgeHours(session.started_at);
  const stale = isStaleSession(session.started_at);

  return (
    <div style={{ ...s.card, borderTop: `3px solid ${stale ? C.chili : C.amber}` }}>
      <div style={s.rowBetween}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: stale ? C.chili : C.amber }}>
          Sesi kerja lain masih terbuka
        </div>
        <span style={pill(stale ? 'bad' : 'warn')}>{session.task_type}</span>
      </div>
      <div style={s.meta}>
        {session.reference_no ?? 'tanpa referensi'} · berjalan {hours.toFixed(1)} jam
        {stale ? ' · kemungkinan tertinggal' : ''}
      </div>
      <p style={{ fontSize: 12.5, color: C.slate, lineHeight: 1.5, margin: '8px 0 0', fontFamily: MONO }}>
        Waktu kerja layar ini belum tercatat sampai sesi lama ditutup.
      </p>
      <button
        style={{ ...s.btnGhost, width: '100%', marginTop: 10, borderColor: C.neo, color: C.neo }}
        disabled={busy}
        onClick={() => { setBusy(true); void onResolve().finally(() => setBusy(false)); }}
      >
        {busy ? 'Menutup…' : 'Tutup sesi lama & mulai di sini'}
      </button>
    </div>
  );
}
