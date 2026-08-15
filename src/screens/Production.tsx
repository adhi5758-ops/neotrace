/**
 * Layar Produksi.
 *
 * Alur: pilih batch → ambil bahan per baris formula (FEFO + scan, ditangani
 * BatchConsumePanel) → catat CCP → tutup batch. Penutupan batch memicu
 * perhitungan yield & HPP di database, lalu menampilkan selisih terhadap
 * standard cost — angka itulah alasan Fase 1 ada.
 */
import { useEffect, useState } from 'react';
import BatchConsumePanel, { handleCloseBatch } from '../components/BatchConsumePanel';
import { recordCcp, parseDbError } from '../lib/api';
import { listBatches, batchRequirements, ccpDefinitions, type Batch, type CcpDefinition } from '../lib/queries';
import { C, MONO, s, pill } from '../ui';

type Requirement = { itemId: string; itemName: string; qtyNeeded: number; uom: string };

export default function Production() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<Batch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listBatches(true)
      .then(setBatches)
      .catch((e) => setErr(parseDbError(e).message))
      .finally(() => setLoading(false));
  }, []);

  if (open) return <BatchDetail batch={open} onBack={() => setOpen(null)} />;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Produksi</h1>
      <p style={s.sub}>{batches.length} batch berjalan</p>
      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat batch…</div>}
      {!loading && batches.length === 0 && <div style={s.empty}>Tidak ada batch terbuka.</div>}

      {batches.map((b) => (
        <button key={b.id} style={{ ...s.card, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setOpen(b)}>
          <div style={s.rowBetween}>
            <div style={s.code}>{b.batch_no}</div>
            <span style={pill(b.status === 'QC_HOLD' ? 'bad' : b.status === 'IN_PROGRESS' ? 'warn' : 'mute')}>
              {b.status}
            </span>
          </div>
          <div style={s.meta}>
            {b.items?.name ?? '—'} · target {b.target_qty} {b.items?.base_uom ?? ''}
            {b.started_at ? ` · mulai ${b.started_at.slice(0, 10)}` : ''}
          </div>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function BatchDetail({ batch, onBack }: { batch: Batch; onBack: () => void }) {
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [ccps, setCcps] = useState<CcpDefinition[]>([]);
  const [active, setActive] = useState<Requirement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof handleCloseBatch>> | null>(null);
  const [form, setForm] = useState({ actualQty: '', rejectQty: '0' });

  useEffect(() => {
    batchRequirements(batch).then(setReqs).catch((e) => setErr(parseDbError(e).message));
    ccpDefinitions(batch.item_id).then(setCcps).catch(() => setCcps([]));
  }, [batch]);

  if (active) {
    return (
      <div style={{ paddingBottom: 80 }}>
        <button style={{ ...s.btnGhost, margin: 16 }} onClick={() => setActive(null)}>‹ Kembali ke batch</button>
        <BatchConsumePanel
          batchId={batch.id}
          itemId={active.itemId}
          itemName={active.itemName}
          qtyNeeded={active.qtyNeeded}
          uom={active.uom}
        />
      </div>
    );
  }

  if (result) {
    const bad = result.variancePct != null && Math.abs(result.variancePct) > 5;
    return (
      <div style={s.page}>
        <h1 style={s.h1}>Batch ditutup</h1>
        <p style={s.sub}>{batch.batch_no} · produk jadi masuk karantina QA</p>
        <div style={{ ...s.card, borderTop: `3px solid ${bad ? C.amber : C.neo}` }}>
          <dl style={kv}>
            <dt>Yield</dt><dd>{fmt(result.yieldPct)} %</dd>
            <dt>HPP aktual</dt><dd>Rp {fmt(result.actualCostPerUom, 0)} / {batch.items?.base_uom}</dd>
            <dt>Standard cost</dt><dd>Rp {fmt(result.standardCost, 0)}</dd>
            <dt>Selisih</dt>
            <dd style={{ color: bad ? C.amber : C.neo }}>{fmt(result.variancePct)} %</dd>
          </dl>
        </div>
        <button style={s.btn} onClick={onBack}>Selesai</button>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar batch</button>
      <h1 style={s.h1}>{batch.batch_no}</h1>
      <p style={s.sub}>{batch.items?.name} · target {batch.target_qty} {batch.items?.base_uom}</p>
      {err && <div style={s.err}>{err}</div>}

      <div style={s.secHead}>Bahan yang harus diambil</div>
      {reqs.length === 0 && <div style={s.empty}>Batch belum punya formula. Hubungi planner.</div>}
      {reqs.map((r) => (
        <button key={r.itemId} style={{ ...s.card, ...s.rowBetween, width: '100%', cursor: 'pointer' }}
                onClick={() => setActive(r)}>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{r.itemName}</div>
            <div style={s.meta}>{r.qtyNeeded} {r.uom}</div>
          </div>
          <span style={{ color: C.neo, fontFamily: MONO, fontSize: 12 }}>Ambil ›</span>
        </button>
      ))}

      {ccps.length > 0 && (
        <>
          <div style={s.secHead}>Titik kendali kritis (CCP)</div>
          {ccps.map((c) => <CcpRow key={c.id} batchId={batch.id} ccp={c} />)}
        </>
      )}

      <div style={s.secHead}>Tutup batch</div>
      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="act">Hasil aktual ({batch.items?.base_uom})</label>
          <input id="act" style={s.input} type="number" inputMode="decimal" step="0.001"
                 value={form.actualQty} onChange={(e) => setForm({ ...form, actualQty: e.target.value })} />
        </div>
        <div>
          <label style={s.label} htmlFor="rej">Reject</label>
          <input id="rej" style={s.input} type="number" inputMode="decimal" step="0.001"
                 value={form.rejectQty} onChange={(e) => setForm({ ...form, rejectQty: e.target.value })} />
        </div>
      </div>

      <button
        style={{ ...s.btn, opacity: closing || !form.actualQty ? 0.5 : 1 }}
        disabled={closing || !form.actualQty}
        onClick={() => {
          if (!confirm('Tutup batch? Lot produk jadi dibuat dan HPP dihitung.')) return;
          setClosing(true);
          setErr(null);
          handleCloseBatch(
            batch.id, batch.item_id, Number(form.actualQty), Number(form.rejectQty) || 0,
            batch.items?.shelf_life_days ?? 0
          )
            .then(setResult)
            .catch((e) => setErr(parseDbError(e).message))
            .finally(() => setClosing(false));
        }}
      >
        {closing ? 'Menghitung HPP…' : 'Tutup batch & hitung HPP'}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- CCP */

function CcpRow({ batchId, ccp }: { batchId: string; ccp: CcpDefinition }) {
  const [val, setVal] = useState('');
  const [action, setAction] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const num = Number(val);
  const outOfSpec = val !== '' && !Number.isNaN(num) && (
    (ccp.min_value != null && num < ccp.min_value) || (ccp.max_value != null && num > ccp.max_value)
  );

  return (
    <div style={s.card}>
      <div style={s.rowBetween}>
        <div style={s.code}>{ccp.code} {ccp.name ? `· ${ccp.name}` : ''}</div>
        {saved && <span style={pill(saved === 'PASS' ? 'ok' : 'bad')}>{saved}</span>}
      </div>
      <div style={s.meta}>
        batas {ccp.min_value ?? '—'} … {ccp.max_value ?? '—'} {ccp.uom ?? ''}
        {ccp.is_critical ? ' · kritis' : ''}
      </div>
      <input style={{ ...s.input, marginTop: 8 }} type="number" inputMode="decimal" step="0.1"
             placeholder="nilai terukur" value={val} onChange={(e) => setVal(e.target.value)} />
      {outOfSpec && (
        <>
          <label style={s.label} htmlFor={`ca-${ccp.id}`}>Di luar batas — tindakan koreksi wajib</label>
          <textarea id={`ca-${ccp.id}`} style={{ ...s.input, resize: 'vertical' }} rows={2}
                    value={action} onChange={(e) => setAction(e.target.value)} />
        </>
      )}
      <button
        style={{ ...s.btnGhost, width: '100%', marginTop: 8, borderColor: outOfSpec ? C.chili : C.line }}
        disabled={busy || val === '' || (outOfSpec && action.trim().length < 8)}
        onClick={() => {
          setBusy(true);
          void recordCcp(batchId, ccp.id, {
            value_num: Number.isNaN(num) ? undefined : num,
            value_text: Number.isNaN(num) ? val : undefined,
            corrective_action: action.trim() || undefined,
          })
            .then((r) => setSaved((r as { result: string }).result))
            .catch(() => setSaved('FAIL'))
            .finally(() => setBusy(false));
        }}
      >
        Catat pembacaan
      </button>
    </div>
  );
}

const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 14px',
  fontSize: 13, fontFamily: MONO, margin: 0,
};
