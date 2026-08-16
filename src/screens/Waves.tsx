/**
 * Gelombang picking (W06 konsol + W07 lembar kerja).
 *
 * Satu layar melayani dua peran: supervisor membentuk gelombang dari beberapa
 * batch dan menugaskannya, petugas membuka lembar kerjanya. Memisahkan jadi
 * dua aplikasi hanya menambah pintu yang harus diajarkan.
 *
 * RAID R31: wave picking belum tentu lebih cepat di lorong sempit. Selama uji
 * coba, discrete picking di layar Pick list tetap tersedia penuh.
 */
import { useCallback, useEffect, useState } from 'react';
import WavePickSheet from '../components/WavePickSheet';
import { supabase, parseDbError } from '../lib/api';
import {
  generateWave, listOpenWaves, assignWave, pickableBatches, waveMessage,
  type PickStrategy,
} from '../lib/api-phase3';
import { C, MONO, s, pill } from '../ui';

interface Wave {
  id: string; wave_no: string; strategy: string; status: string;
  planned_for: string | null; started_at: string | null;
  profiles: { full_name: string | null } | null;
}

interface Pickable {
  id: string; batch_no: string; target_qty: number; status: string;
  items: { name: string } | null;
}

const STRATEGIES: { value: PickStrategy; label: string; hint: string }[] = [
  { value: 'BATCH', label: 'Batch', hint: 'Beberapa batch sekaligus, satu tote per batch' },
  { value: 'ZONE', label: 'Zona', hint: 'Dibatasi satu zona rak' },
  { value: 'CLUSTER', label: 'Cluster', hint: 'Kelompok batch berdekatan' },
];

export default function Waves() {
  const [waves, setWaves] = useState<Wave[]>([]);
  const [open, setOpen] = useState<Wave | null>(null);
  const [forming, setForming] = useState(false);
  const [err, setErr] = useState<{ title: string; hint: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setWaves((await listOpenWaves()) as unknown as Wave[]);
      setErr(null);
    } catch (e) {
      setErr({ title: 'Gagal memuat gelombang', hint: parseDbError(e).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (open) {
    return (
      <div style={{ paddingBottom: 80 }}>
        <button style={{ ...s.btnGhost, margin: 16 }} onClick={() => { setOpen(null); void refresh(); }}>
          ‹ Daftar gelombang
        </button>
        <WavePickSheet
          waveId={open.id}
          waveNo={open.wave_no}
          onFinish={() => { setOpen(null); void refresh(); }}
        />
      </div>
    );
  }

  if (forming) {
    return <FormWave onBack={() => setForming(false)} onCreated={() => { setForming(false); void refresh(); }} />;
  }

  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Gelombang</h1>
      <p style={s.sub}>{waves.length} gelombang berjalan · satu jalan untuk banyak batch</p>
      {err && <div style={s.err}>{err.title} — {err.hint}</div>}

      <button style={{ ...s.btn, maxWidth: 320 }} onClick={() => setForming(true)}>Bentuk gelombang baru</button>

      <div style={s.secHead}>Gelombang terbuka</div>
      {loading && <div style={s.empty}>Memuat…</div>}
      {!loading && waves.length === 0 && (
        <div style={s.empty}>Belum ada gelombang. Bentuk dari batch yang sudah punya formula.</div>
      )}

      <div style={s.cardGrid}>
        {waves.map((w) => (
          <div key={w.id} style={{ ...s.card, marginBottom: 0 }}>
            <div style={s.rowBetween}>
              <div style={s.code}>{w.wave_no}</div>
              <span style={pill(w.status === 'IN_PROGRESS' ? 'warn' : w.status === 'ASSIGNED' ? 'ok' : 'mute')}>
                {w.status}
              </span>
            </div>
            <div style={s.meta}>
              strategi {w.strategy} · petugas {w.profiles?.full_name ?? 'belum ditugaskan'}
              {w.planned_for ? ` · rencana ${w.planned_for.slice(0, 16).replace('T', ' ')}` : ''}
            </div>
            <div style={{ ...s.grid2, marginTop: 10 }}>
              <AssignPicker waveId={w.id} onDone={refresh} />
              <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }} onClick={() => setOpen(w)}>
                Buka lembar kerja
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- bentuk wave */

function FormWave({ onBack, onCreated }: { onBack: () => void; onCreated: () => void }) {
  const [batches, setBatches] = useState<Pickable[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<PickStrategy>('BATCH');
  const [plannedFor, setPlannedFor] = useState('');
  const [err, setErr] = useState<{ title: string; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    pickableBatches()
      .then((b) => setBatches(b as unknown as Pickable[]))
      .catch((e) => setErr({ title: 'Gagal memuat batch', hint: parseDbError(e).message }))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id: string) =>
    setSel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await generateWave(sel, strategy, undefined, plannedFor || undefined);
      onCreated();
    } catch (e) {
      const { code, message } = e as { code: string; message: string };
      const m = waveMessage(code);
      setErr({ title: m.title, hint: code === 'UNKNOWN' ? message : m.hint });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.pageWide}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar gelombang</button>
      <h1 style={s.h1}>Bentuk gelombang</h1>
      <p style={s.sub}>{sel.length} batch dipilih · satu tote per batch</p>
      {err && <div style={s.err}>{err.title} — {err.hint}</div>}

      <div style={s.secHead}>Strategi</div>
      <div style={s.cardGrid}>
        {STRATEGIES.map((st) => (
          <button key={st.value}
                  style={{ ...s.card, ...s.rowBetween, marginBottom: 0, width: '100%', cursor: 'pointer',
                           borderColor: strategy === st.value ? C.neo : C.line }}
                  onClick={() => setStrategy(st.value)}>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{st.label}</div>
              <div style={s.meta}>{st.hint}</div>
            </div>
            <span style={pill(strategy === st.value ? 'ok' : 'mute')}>
              {strategy === st.value ? 'DIPILIH' : '—'}
            </span>
          </button>
        ))}
      </div>

      <div style={s.secHead}>Batch siap dijadwalkan</div>
      {loading && <div style={s.empty}>Memuat batch…</div>}
      {!loading && batches.length === 0 && (
        <div style={s.empty}>
          Tidak ada batch yang bisa digelombangkan. Batch harus punya formula dan belum masuk gelombang lain.
        </div>
      )}
      <div style={s.cardGrid}>
        {batches.map((b) => {
          const on = sel.includes(b.id);
          return (
            <button key={b.id}
                    style={{ ...s.card, ...s.rowBetween, marginBottom: 0, width: '100%', cursor: 'pointer',
                             borderColor: on ? C.neo : C.line }}
                    onClick={() => toggle(b.id)}>
              <div style={{ textAlign: 'left' }}>
                <div style={s.code}>{b.batch_no}</div>
                <div style={s.meta}>{b.items?.name ?? '—'} · target {b.target_qty} · {b.status}</div>
              </div>
              <span style={{ ...s.code, color: on ? C.neo : C.slate }}>
                {on ? `TOTE-${String(sel.indexOf(b.id) + 1).padStart(2, '0')}` : '—'}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ maxWidth: 420 }}>
        <label style={s.label} htmlFor="plan">Rencana mulai (opsional)</label>
        <input id="plan" style={s.input} type="datetime-local" value={plannedFor}
               onChange={(e) => setPlannedFor(e.target.value)} />

        <button style={{ ...s.btn, opacity: busy || sel.length === 0 ? 0.5 : 1 }}
                disabled={busy || sel.length === 0}
                onClick={() => void create()}>
          {busy ? 'Membentuk…' : `Bentuk gelombang dari ${sel.length} batch`}
        </button>
        {sel.length === 1 && (
          <p style={{ ...s.meta, marginTop: 10 }}>
            Satu batch saja tidak menghemat langkah — pakai Pick list biasa kecuali memang disengaja.
          </p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- tugaskan petugas */

function AssignPicker({ waveId, onDone }: { waveId: string; onDone: () => void }) {
  const [pickers, setPickers] = useState<{ id: string; full_name: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void supabase
      .from('profiles')
      .select('id, full_name')
      .eq('is_active', true)
      .in('role', ['WAREHOUSE', 'OPERATOR', 'ADMIN'])
      .order('full_name')
      .then(({ data }) => setPickers((data ?? []) as { id: string; full_name: string | null }[]));
  }, []);

  return (
    <select
      style={{ ...s.input, padding: 10, fontSize: 12 }}
      defaultValue=""
      disabled={busy}
      onChange={(e) => {
        if (!e.target.value) return;
        setBusy(true);
        void assignWave(waveId, e.target.value).then(onDone).finally(() => setBusy(false));
      }}
    >
      <option value="">— tugaskan —</option>
      {pickers.map((p) => (
        <option key={p.id} value={p.id}>{p.full_name ?? p.id.slice(0, 8)}</option>
      ))}
    </select>
  );
}
