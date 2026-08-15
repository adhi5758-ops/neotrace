/**
 * Peringatan dari job harian: kedaluwarsa 90/60/30/14/7, sertifikat halal,
 * retain sample jatuh tempo, pelanggaran FEFO. Realtime lewat Supabase.
 */
import { useEffect, useState } from 'react';
import { openNotifications, subscribeNotifications, supabase, parseDbError } from '../lib/api';
import { markNotificationRead } from '../lib/queries';
import { C, s, pill } from '../ui';

interface Notif {
  id: number; type: string; severity: string; title: string; body: string | null; created_at: string;
}

const tone = (sev: string) => (sev === 'CRITICAL' ? 'bad' : sev === 'WARN' ? 'warn' : 'mute');

type Props = { onRead: () => void };

export default function Notifications({ onRead }: Props) {
  const [rows, setRows] = useState<Notif[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () => openNotifications()
      .then((d) => setRows(d as unknown as Notif[]))
      .catch((e) => setErr(parseDbError(e).message))
      .finally(() => setLoading(false));
    void load();
    const chan = subscribeNotifications(() => void load());
    return () => { void supabase.removeChannel(chan); };
  }, []);

  async function dismiss(id: number) {
    setRows((r) => r.filter((x) => x.id !== id));
    onRead();
    try { await markNotificationRead(id); } catch (e) { setErr(parseDbError(e).message); }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Peringatan</h1>
      <p style={s.sub}>{rows.length} belum dibaca</p>
      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat…</div>}
      {!loading && rows.length === 0 && <div style={s.empty}>Tidak ada peringatan terbuka.</div>}

      {rows.map((n) => (
        <div key={n.id} style={{ ...s.card, borderTop: `3px solid ${n.severity === 'CRITICAL' ? C.chili : n.severity === 'WARN' ? C.amber : C.line}` }}>
          <div style={s.rowBetween}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{n.title}</div>
            <span style={pill(tone(n.severity))}>{n.type}</span>
          </div>
          {n.body && <div style={{ ...s.meta, lineHeight: 1.5 }}>{n.body}</div>}
          <div style={{ ...s.rowBetween, marginTop: 10 }}>
            <span style={s.meta}>{n.created_at.slice(0, 16).replace('T', ' ')}</span>
            <button style={{ ...s.btnGhost, padding: '7px 11px', fontSize: 12 }} onClick={() => void dismiss(n.id)}>
              Sudah dibaca
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
