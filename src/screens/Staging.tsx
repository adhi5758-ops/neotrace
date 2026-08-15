/**
 * Papan Staging (P27).
 *
 * Satu lokasi staging = satu batch. Indeks unik di database yang menegakkan;
 * layar ini hanya menunjukkan siapa menempati apa dan sudah berapa lama,
 * supaya bahan antar lini masak tidak tertukar.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseDbError } from '../lib/api';
import { listBatches, listLocations, type Batch, type Location } from '../lib/queries';
import {
  stagingBoard, assignStaging, releaseStaging, openStagingAssignments,
  type StagingBoardRow,
} from '../lib/picking';
import { C, MONO, s, pill } from '../ui';

type Assignment = Awaited<ReturnType<typeof openStagingAssignments>>[number];

export default function Staging() {
  const [board, setBoard] = useState<StagingBoardRow[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [stagingLocs, setStagingLocs] = useState<Location[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [form, setForm] = useState({ locationId: '', batchId: '', lineCode: '' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, a, locs, bt] = await Promise.all([
        stagingBoard(), openStagingAssignments(), listLocations(), listBatches(true),
      ]);
      setBoard(b);
      setAssignments(a);
      setStagingLocs(locs.filter((l) => l.is_staging));
      setBatches(bt);
    } catch (e) {
      setMsg({ tone: 'bad', text: parseDbError(e).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await load(); }
    catch (e) { setMsg({ tone: 'bad', text: (e as { message?: string }).message ?? parseDbError(e).message }); }
    finally { setBusy(false); }
  }

  const occupiedIds = new Set(assignments.map((a) => a.location_id));
  const freeLocs = stagingLocs.filter((l) => !occupiedIds.has(l.id));

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Staging</h1>
      <p style={s.sub}>{assignments.length} dari {stagingLocs.length} area terpakai</p>
      {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}
      {loading && <div style={s.empty}>Memuat papan…</div>}

      <div style={s.secHead}>Papan area</div>
      {board.length === 0 && !loading && (
        <div style={s.empty}>Belum ada lokasi bertanda staging di master lokasi.</div>
      )}
      {board.map((r) => {
        const busyRow = Boolean(r.batch_no);
        const assignment = assignments.find((a) => a.locations?.code === r.location_code);
        const stale = (r.hours_occupied ?? 0) > 8;
        return (
          <div key={r.location_code}
               style={{ ...s.card, borderTop: `3px solid ${busyRow ? (stale ? C.amber : C.neo) : C.line}` }}>
            <div style={s.rowBetween}>
              <div style={s.code}>{r.location_code}</div>
              <span style={pill(busyRow ? (stale ? 'warn' : 'ok') : 'mute')}>
                {busyRow ? 'TERPAKAI' : 'KOSONG'}
              </span>
            </div>
            <div style={s.meta}>{r.location_name ?? '—'}{r.line_code ? ` · lini ${r.line_code}` : ''}</div>
            {busyRow && (
              <>
                <dl style={kv}>
                  <dt>Batch</dt><dd>{r.batch_no}</dd>
                  <dt>Produk</dt><dd>{r.product_name ?? '—'}</dd>
                  <dt>Pick list</dt>
                  <dd>{r.pick_list_no ?? '—'} {r.pick_status ? `· ${r.pick_status}` : ''}</dd>
                  <dt>Sudah</dt>
                  <dd style={{ color: stale ? C.amber : C.ink }}>{r.hours_occupied ?? 0} jam</dd>
                </dl>
                {assignment && (
                  <button style={{ ...s.btnGhost, width: '100%', marginTop: 8 }} disabled={busy}
                          onClick={() => void run(() => releaseStaging(assignment.id), `Area ${r.location_code} dilepas.`)}>
                    Lepaskan area
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}

      <div style={s.secHead}>Tugaskan area</div>
      <label style={s.label} htmlFor="loc">Area staging kosong</label>
      <select id="loc" style={s.input} value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
        <option value="">— pilih area —</option>
        {freeLocs.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
      </select>

      <label style={s.label} htmlFor="btc">Batch</label>
      <select id="btc" style={s.input} value={form.batchId}
              onChange={(e) => setForm({ ...form, batchId: e.target.value })}>
        <option value="">— pilih batch —</option>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>{b.batch_no} · {b.items?.name}</option>
        ))}
      </select>

      <label style={s.label} htmlFor="line">Kode lini masak (opsional)</label>
      <input id="line" style={s.input} value={form.lineCode} placeholder="SAUCE-1"
             onChange={(e) => setForm({ ...form, lineCode: e.target.value })} />

      <button style={{ ...s.btn, opacity: busy || !form.locationId || !form.batchId ? 0.5 : 1 }}
              disabled={busy || !form.locationId || !form.batchId}
              onClick={() => void run(
                () => assignStaging(form.locationId, form.batchId, form.lineCode),
                'Area staging ditugaskan.'
              )}>
        Tugaskan
      </button>
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px',
  fontSize: 12.5, fontFamily: MONO, margin: '10px 0 0',
};
