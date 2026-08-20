/**
 * Layar QC Hold.
 *
 * Antrean lot karantina diurutkan dari yang paling lama tertahan — lot yang
 * menunggu 40 jam menahan produksi dan memakan umur simpan. Tombol release
 * sengaja tidak disembunyikan untuk non-QA: database yang menolak, dan pesan
 * penolakannya mengajari siapa yang berwenang.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  releaseLot, holdLot, quarantineCascade, listQcPending,
  createIncomingSample, recordTestResult, parseDbError,
} from '../lib/api';
import { reverseReceipt } from '../lib/api-phase6';
import { addTest, lotSamples, type QcPendingRow, type QcSample, type QcTest } from '../lib/queries';
import { C, MONO, s, pill } from '../ui';

const TEST_TYPES = ['MICROBIOLOGY', 'ORGANOLEPTIC', 'CHEMICAL', 'PHYSICAL', 'ALLERGEN', 'FOREIGN_BODY'];

type Props = { role?: string };

export default function Qc({ role }: Props) {
  const [queue, setQueue] = useState<QcPendingRow[]>([]);
  const [open, setOpen] = useState<QcPendingRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setQueue((await listQcPending()) as QcPendingRow[]);
      setErr(null);
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (open) return <LotDetail row={open} role={role} onBack={() => { setOpen(null); void refresh(); }} />;

  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>QC hold</h1>
      <p style={s.sub}>{queue.length} lot menunggu keputusan QA</p>
      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat antrean…</div>}
      {!loading && queue.length === 0 && <div style={s.empty}>Tidak ada lot tertahan. Bagus.</div>}

      <div style={s.cardGrid}>
        {queue.map((q) => (
          <button key={q.lot_id} style={{ ...s.card, marginBottom: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setOpen(q)}>
            <div style={s.rowBetween}>
              <div style={s.code}>{q.lot_code}</div>
              <span style={pill(q.failed_tests > 0 ? 'bad' : q.pending_tests > 0 ? 'warn' : 'ok')}>
                {q.failed_tests > 0 ? `${q.failed_tests} GAGAL`
                  : q.pending_tests > 0 ? `${q.pending_tests} MENUNGGU`
                  : 'SIAP RELEASE'}
              </span>
            </div>
            <div style={s.meta}>
              {q.item_name} · {q.supplier_name ?? 'tanpa supplier'} · tertahan {Math.round(q.hours_on_hold)} jam
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function LotDetail({ row, role, onBack }: { row: QcPendingRow; role?: string; onBack: () => void }) {
  const [samples, setSamples] = useState<QcSample[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    void lotSamples(row.lot_id).then(setSamples).catch((e) => setMsg({ tone: 'bad', text: parseDbError(e).message }));
  }, [row.lot_id]);
  useEffect(load, [load]);

  async function run(
    fn: () => Promise<{ tone: 'ok' | 'bad'; text: string } | void>,
    okText: string
  ) {
    setBusy(true);
    setMsg(null);
    try {
      // fn bisa mengembalikan pesan lebih rinci (mis. jumlah lot/batch yang
      // terkunci saat recall) — dulu setMsg di dalam fn selalu langsung
      // ditimpa oleh okText di sini, jadi detailnya tidak pernah terlihat.
      const detail = await fn();
      setMsg(detail ?? { tone: 'ok', text: okText });
      load();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as { message?: string }).message ?? parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  const canDecide = !role || role === 'QA' || role === 'ADMIN';

  return (
    <div style={s.pageWide}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Antrean QC</button>
      <h1 style={s.h1}>{row.lot_code}</h1>
      <p style={s.sub}>{row.item_name} · {row.supplier_name ?? '—'} · tertahan {Math.round(row.hours_on_hold)} jam</p>

      {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}

      <div style={s.secHead}>Sampel & uji</div>
      {samples.length === 0 && <div style={s.empty}>Belum ada sampel diambil untuk lot ini.</div>}
      <div style={s.cardGrid}>
        {samples.map((sm) => (
          <div key={sm.id} style={{ ...s.card, marginBottom: 0 }}>
            <div style={s.rowBetween}>
              <div style={s.code}>{sm.sample_no}</div>
              <span style={pill('mute')}>{sm.type}</span>
            </div>
            <div style={s.meta}>{sm.qty ?? '—'} {sm.uom ?? ''} · diambil {sm.taken_at.slice(0, 16).replace('T', ' ')}</div>
            {sm.qc_tests?.map((t) => <TestRow key={t.id} test={t} onSaved={load} />)}
            <AddTest sampleId={sm.id} onAdded={load} />
          </div>
        ))}
      </div>

      <button
        style={{ ...s.btnGhost, width: '100%', maxWidth: 320, marginTop: 10 }}
        disabled={busy}
        onClick={() => void run(
          async () => { await createIncomingSample(row.lot_id, 0.25, 'KG'); },
          'Sampel incoming dibuat.'
        )}
      >
        + Ambil sampel incoming
      </button>

      <div style={s.secHead}>Keputusan</div>
      <div style={{ maxWidth: 480 }}>
        {!canDecide && <div style={s.empty}>Anda masuk sebagai {role}. Hanya QA yang boleh memutuskan.</div>}
        <label style={s.label} htmlFor="reason">Alasan / catatan (wajib untuk tahan & recall)</label>
        <textarea id="reason" style={{ ...s.input, resize: 'vertical' }} rows={2}
                  value={reason} onChange={(e) => setReason(e.target.value)} />

        <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={busy}
                onClick={() => void run(() => releaseLot(row.lot_id, reason || undefined), 'Lot dilepas — boleh dipakai produksi.')}>
          Release lot
        </button>
        <button style={{ ...s.btn, background: C.amber, opacity: busy || reason.trim().length < 4 ? 0.5 : 1 }}
                disabled={busy || reason.trim().length < 4}
                onClick={() => void run(() => holdLot(row.lot_id, reason.trim()), 'Lot ditahan.')}>
          Tahan lot
        </button>
        <button style={{ ...s.btn, background: C.chili, opacity: busy || reason.trim().length < 8 ? 0.5 : 1 }}
                disabled={busy || reason.trim().length < 8}
                onClick={() => {
                  if (!confirm(`Recall akan mengunci lot ini DAN seluruh produk jadi turunannya. Lanjut?`)) return;
                  void run(async () => {
                    const r = await quarantineCascade(row.lot_id, reason.trim());
                    return { tone: 'bad' as const, text: `Recall: ${r.blocked_lots} lot produk jadi dan ${r.held_batches} batch dikunci.` };
                  }, 'Recall dijalankan.');
                }}>
          Recall (kunci turunan)
        </button>
        <button style={{ ...s.btnGhost, width: '100%', marginTop: 10, borderColor: C.chili, color: C.chili, opacity: busy || reason.trim().length < 8 ? 0.5 : 1 }}
                disabled={busy || reason.trim().length < 8}
                onClick={() => void run(() => reverseReceipt(row.lot_id, reason.trim()), 'Penerimaan dibatalkan.')}>
          Batalkan penerimaan
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- uji lab */

function TestRow({ test, onSaved }: { test: QcTest; onSaved: () => void }) {
  const [val, setVal] = useState(test.result_num?.toString() ?? test.result_text ?? '');
  const [lab, setLab] = useState(test.lab_name ?? '');
  const [busy, setBusy] = useState(false);

  const specRange = [
    test.spec_min != null ? `≥ ${test.spec_min}` : null,
    test.spec_max != null ? `≤ ${test.spec_max}` : null,
  ].filter(Boolean).join(' & ');
  const spec = test.spec_text ?? (specRange || '—');

  const tone = test.result === 'PASS' ? 'ok' : test.result === 'FAIL' ? 'bad' : 'warn';

  async function save() {
    setBusy(true);
    try {
      const num = Number(val);
      await recordTestResult(test.id, {
        result_num: val !== '' && !Number.isNaN(num) ? num : undefined,
        result_text: Number.isNaN(num) || val === '' ? val : undefined,
        lab_name: lab || undefined,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={testRow}>
      <div style={s.rowBetween}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {test.parameter}{test.is_mandatory && <span style={{ color: C.chili }}> *</span>}
        </div>
        <span style={pill(tone)}>{test.result}</span>
      </div>
      <div style={s.meta}>{test.test_type} · spesifikasi {spec} · {test.method ?? 'metode —'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, marginTop: 8 }}>
        <input style={{ ...s.input, padding: 8, fontSize: 13 }} value={val} placeholder="hasil"
               onChange={(e) => setVal(e.target.value)} />
        <input style={{ ...s.input, padding: 8, fontSize: 13 }} value={lab} placeholder="lab"
               onChange={(e) => setLab(e.target.value)} />
        <button style={{ ...s.btnGhost, padding: '8px 12px' }} disabled={busy} onClick={() => void save()}>
          Simpan
        </button>
      </div>
    </div>
  );
}

function AddTest({ sampleId, onAdded }: { sampleId: string; onAdded: () => void }) {
  const [show, setShow] = useState(false);
  const [t, setT] = useState({ test_type: 'MICROBIOLOGY', parameter: '', is_mandatory: true, spec_min: '', spec_max: '', spec_text: '' });
  const [busy, setBusy] = useState(false);

  if (!show) {
    return (
      <button style={{ ...s.btnGhost, width: '100%', marginTop: 10, fontSize: 12 }} onClick={() => setShow(true)}>
        + Tambah parameter uji
      </button>
    );
  }

  return (
    <div style={{ ...testRow, borderTop: `2px solid ${C.neo}` }}>
      <select style={{ ...s.input, padding: 8, fontSize: 13 }} value={t.test_type}
              onChange={(e) => setT({ ...t, test_type: e.target.value })}>
        {TEST_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <input style={{ ...s.input, padding: 8, fontSize: 13, marginTop: 6 }} placeholder="parameter (TPC, pH, …)"
             value={t.parameter} onChange={(e) => setT({ ...t, parameter: e.target.value })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
        <input style={{ ...s.input, padding: 8, fontSize: 13 }} placeholder="min" inputMode="decimal"
               value={t.spec_min} onChange={(e) => setT({ ...t, spec_min: e.target.value })} />
        <input style={{ ...s.input, padding: 8, fontSize: 13 }} placeholder="max" inputMode="decimal"
               value={t.spec_max} onChange={(e) => setT({ ...t, spec_max: e.target.value })} />
      </div>
      <input style={{ ...s.input, padding: 8, fontSize: 13, marginTop: 6 }} placeholder="spesifikasi teks (negatif / 25 g)"
             value={t.spec_text} onChange={(e) => setT({ ...t, spec_text: e.target.value })} />
      <label style={{ ...s.meta, display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
        <input type="checkbox" checked={t.is_mandatory} onChange={(e) => setT({ ...t, is_mandatory: e.target.checked })} />
        Uji wajib (memblokir release)
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
        <button style={s.btnGhost} onClick={() => setShow(false)}>Batal</button>
        <button
          style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }}
          disabled={busy || !t.parameter.trim()}
          onClick={() => {
            setBusy(true);
            void addTest(sampleId, {
              test_type: t.test_type,
              parameter: t.parameter.trim(),
              is_mandatory: t.is_mandatory,
              spec_min: t.spec_min ? Number(t.spec_min) : null,
              spec_max: t.spec_max ? Number(t.spec_max) : null,
              spec_text: t.spec_text || null,
            }).then(() => { setShow(false); onAdded(); }).finally(() => setBusy(false));
          }}
        >
          Tambah
        </button>
      </div>
    </div>
  );
}

const testRow: React.CSSProperties = {
  borderTop: `1px solid ${C.line}`, paddingTop: 10, marginTop: 10, fontFamily: MONO,
};
