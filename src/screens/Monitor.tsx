/**
 * Dasbor monitoring — jalur terpisah (/monitor), sama seperti /notifikasi:
 * bukan tab utama, hanya bisa dicapai lewat URL langsung. Untuk siapa saja
 * yang perlu satu layar kesehatan sistem (put-away/pick/wave terbuka,
 * kepatuhan, integrasi ERP, peringatan terbaru) tanpa masuk ke tiap layar
 * operasional satu per satu. Refresh otomatis tiap 30 detik.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseDbError } from '../lib/api';
import { opsScorecard } from '../lib/api-phase3';
import { syncHealth, type SyncHealthRow } from '../lib/api-phase4';
import { recentAlerts, type AlertRow } from '../lib/queries';
import { C, MONO, s, pill } from '../ui';

const REFRESH_MS = 30_000;

type Scorecard = Awaited<ReturnType<typeof opsScorecard>>;

export default function Monitor() {
  const [card, setCard] = useState<Scorecard | null>(null);
  const [sync, setSync] = useState<SyncHealthRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [c, sy, al] = await Promise.all([opsScorecard(), syncHealth(), recentAlerts()]);
      setCard(c);
      setSync(sy);
      setAlerts(al);
      setErr(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={s.page}>
      <div style={s.rowBetween}>
        <div>
          <h1 style={s.h1}>Monitoring</h1>
          <p style={s.sub}>Kesehatan sistem · refresh otomatis 30 detik</p>
        </div>
        <button style={{ ...s.btnGhost, fontSize: 11, padding: '8px 12px' }} onClick={() => void load()}>
          Segarkan
        </button>
      </div>
      {updatedAt && (
        <div style={{ ...s.meta, marginTop: -10, marginBottom: 14 }}>
          diperbarui {updatedAt.toLocaleTimeString('id-ID')}
        </div>
      )}

      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat…</div>}

      {card && (
        <>
          <div style={s.secHead}>Pekerjaan terbuka</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <Stat label="Put-away" value={card.open_putaway} />
            <Stat label="Pick list" value={card.open_picks} />
            <Stat label="Gelombang" value={card.open_waves} />
          </div>

          <div style={s.secHead}>Kepatuhan</div>
          <Metric label="Put-away sesuai saran" value={card.putaway_compliance_pct} good={(v) => v >= 90} />
          <Metric label="Pengambilan tanpa override FEFO" value={card.fefo_compliance_pct} good={(v) => v >= 95} />
        </>
      )}

      <div style={s.secHead}>Integrasi ERP</div>
      {sync.length === 0 && <div style={s.empty}>Belum ada endpoint integrasi terdaftar.</div>}
      {sync.map((sy) => (
        <div key={sy.endpoint} style={s.card}>
          <div style={s.rowBetween}>
            <div style={s.code}>{sy.endpoint}</div>
            <span style={pill(sy.dead > 0 ? 'bad' : sy.failed > 0 ? 'warn' : 'ok')}>
              {sy.dead > 0 ? `${sy.dead} MATI` : sy.failed > 0 ? `${sy.failed} GAGAL` : 'SEHAT'}
            </span>
          </div>
          <div style={s.meta}>
            {sy.pending} menunggu · {sy.acked_24h} terkirim (24 jam) · {sy.direction}
          </div>
        </div>
      ))}

      <div style={s.secHead}>Peringatan terbaru</div>
      {alerts.length === 0 && <div style={s.empty}>Tidak ada peringatan.</div>}
      {alerts.map((a) => (
        <div key={a.id} style={{
          ...s.card, borderTop: `3px solid ${a.severity === 'CRITICAL' ? C.chili : a.severity === 'WARN' ? C.amber : C.line}`,
          opacity: a.read_at ? 0.55 : 1,
        }}>
          <div style={s.rowBetween}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{a.title}</div>
            <span style={pill(a.read_at ? 'mute' : a.severity === 'CRITICAL' ? 'bad' : 'warn')}>{a.type}</span>
          </div>
          {a.body && <div style={{ ...s.meta, lineHeight: 1.5 }}>{a.body}</div>}
          <div style={{ ...s.meta, marginTop: 6, fontFamily: MONO }}>
            {a.created_at.slice(0, 16).replace('T', ' ')}
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ ...s.card, textAlign: 'center', marginBottom: 0 }}>
      <div style={{ fontSize: 26, fontFamily: MONO, fontWeight: 700, color: value > 0 ? C.ink : C.slate }}>
        {value}
      </div>
      <div style={{ ...s.meta, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: number | null; good: (v: number) => boolean }) {
  const ok = value != null && good(value);
  return (
    <div style={{ ...s.card, borderTop: `3px solid ${value == null ? C.line : ok ? C.neo : C.amber}` }}>
      <div style={s.rowBetween}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
        <div style={{ ...s.code, fontSize: 16, color: value == null ? C.slate : ok ? C.neo : C.amber }}>
          {value ?? '—'} <span style={{ fontSize: 10, color: C.slate }}>%</span>
        </div>
      </div>
    </div>
  );
}
