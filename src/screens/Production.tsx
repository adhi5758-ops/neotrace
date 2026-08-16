/**
 * Layar Produksi.
 *
 * Alur: pilih batch → ambil bahan per baris formula (FEFO + scan, ditangani
 * BatchConsumePanel) → catat CCP → tutup batch. Penutupan batch memicu
 * perhitungan yield & HPP di database, lalu menampilkan selisih terhadap
 * standard cost — angka itulah alasan Fase 1 ada.
 */
import { useCallback, useEffect, useState } from 'react';
import BatchConsumePanel, { handleCloseBatch } from '../components/BatchConsumePanel';
import { recordCcp, consumeLot, parseDbError } from '../lib/api';
import { listBatches, batchRequirements, ccpDefinitions, type Batch, type CcpDefinition } from '../lib/queries';
import { listPickLists, generatePickList, pickedLines, type PickList } from '../lib/picking';
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
    <div style={s.pageWide}>
      <h1 style={s.h1}>Produksi</h1>
      <p style={s.sub}>{batches.length} batch berjalan</p>
      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat batch…</div>}
      {!loading && batches.length === 0 && <div style={s.empty}>Tidak ada batch terbuka.</div>}

      <div style={s.cardGrid}>
        {batches.map((b) => (
          <button key={b.id} style={{ ...s.card, marginBottom: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setOpen(b)}>
            <div style={s.rowBetween}>
              <div style={s.code}>{b.batch_no}</div>
              <span style={pill(b.status === 'QC_HOLD' ? 'bad' : b.status === 'RUNNING' ? 'warn' : 'mute')}>
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
      <div style={s.pageWide}>
        <h1 style={s.h1}>Batch ditutup</h1>
        <p style={s.sub}>{batch.batch_no} · produk jadi masuk karantina QA</p>
        <div style={{ ...s.card, maxWidth: 480, borderTop: `3px solid ${bad ? C.amber : C.neo}` }}>
          <dl style={kv}>
            <dt>Yield</dt><dd>{fmt(result.yieldPct)} %</dd>
            <dt>HPP aktual</dt><dd>Rp {fmt(result.actualCostPerUom, 0)} / {batch.items?.base_uom}</dd>
            <dt>Standard cost</dt><dd>Rp {fmt(result.standardCost, 0)}</dd>
            <dt>Selisih</dt>
            <dd style={{ color: bad ? C.amber : C.neo }}>{fmt(result.variancePct)} %</dd>
          </dl>
        </div>
        <button style={{ ...s.btn, maxWidth: 320 }} onClick={onBack}>Selesai</button>
      </div>
    );
  }

  return (
    <div style={s.pageWide}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar batch</button>
      <h1 style={s.h1}>{batch.batch_no}</h1>
      <p style={s.sub}>{batch.items?.name} · target {batch.target_qty} {batch.items?.base_uom}</p>
      {err && <div style={s.err}>{err}</div>}

      <PickListPanel batch={batch} />

      <div style={s.secHead}>Bahan yang harus diambil</div>
      {reqs.length === 0 && <div style={s.empty}>Batch belum punya formula. Hubungi planner.</div>}
      <div style={s.cardGrid}>
        {reqs.map((r) => (
          <button key={r.itemId} style={{ ...s.card, ...s.rowBetween, marginBottom: 0, width: '100%', cursor: 'pointer' }}
                  onClick={() => setActive(r)}>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{r.itemName}</div>
              <div style={s.meta}>{r.qtyNeeded} {r.uom}</div>
            </div>
            <span style={{ color: C.neo, fontFamily: MONO, fontSize: 12 }}>Ambil ›</span>
          </button>
        ))}
      </div>

      {ccps.length > 0 && (
        <>
          <div style={s.secHead}>Titik kendali kritis (CCP)</div>
          <div style={s.cardGrid}>
            {ccps.map((c) => <CcpRow key={c.id} batchId={batch.id} ccp={c} />)}
          </div>
        </>
      )}

      <div style={s.secHead}>Tutup batch</div>
      <div style={{ ...s.grid2, maxWidth: 480 }}>
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
        style={{ ...s.btn, maxWidth: 480, opacity: closing || !form.actualQty ? 0.5 : 1 }}
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

/* ------------------------------------------------------- pick list (P28) */

/**
 * Jembatan Fase 2 → Fase 1. Picking mencatat pergerakan stok keluar rak,
 * tapi konsumsi batch (yang membentuk HPP) tetap tabel `batch_consumption`.
 * Tombol di sini memindahkan baris yang sudah dipetik ke sana sekali jalan,
 * supaya operator tidak memindai bahan yang sama dua kali.
 */
function PickListPanel({ batch }: { batch: Batch }) {
  const [list, setList] = useState<PickList | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listPickLists(false)
      .then((all) => setList(all.find((p) => p.batch_id === batch.id && p.status !== 'CANCELLED') ?? null))
      .catch((e) => setMsg({ tone: 'bad', text: parseDbError(e).message }))
      .finally(() => setLoading(false));
  }, [batch.id]);
  useEffect(load, [load]);

  async function issue() {
    setBusy(true);
    setMsg(null);
    try {
      await generatePickList(batch.id);
      setMsg({ tone: 'ok', text: 'Pick list terbit. Tugaskan petugas di konsol gudang.' });
      load();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as { message?: string }).message ?? parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  /** Catat seluruh baris terpetik sebagai konsumsi batch. Sudah tercatat → dilewati. */
  async function consumeFromPick() {
    if (!list) return;
    setBusy(true);
    setMsg(null);
    try {
      const picked = await pickedLines(list.id);
      let ok = 0;
      const failed: string[] = [];
      for (const p of picked) {
        try {
          await consumeLot({
            batchId: batch.id,
            lotId: p.picked_lot_id,
            itemId: p.item_id,
            huId: p.picked_hu_id ?? undefined,
            qtyActual: p.qty_picked,
            uom: p.uom,
            fefoOverride: p.fefo_override,
            overrideReason: p.override_reason ?? undefined,
          });
          ok++;
        } catch (e) {
          failed.push((e as { message?: string }).message ?? 'gagal');
        }
      }
      setMsg(failed.length
        ? { tone: 'bad', text: `${ok} baris tercatat, ${failed.length} gagal: ${failed[0]}` }
        : { tone: 'ok', text: `${ok} baris konsumsi tercatat dari pick list.` });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div style={s.empty}>Memeriksa pick list…</div>;

  return (
    <>
      <div style={s.secHead}>Pick list</div>
      {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}

      {!list && (
        <>
          <div style={s.empty}>Belum ada pick list. Terbitkan untuk menyiapkan bahan lewat gudang.</div>
          <button style={{ ...s.btnGhost, width: '100%' }} disabled={busy || !batch.formula_id}
                  onClick={() => void issue()}>
            {busy ? 'Menerbitkan…' : 'Terbitkan pick list dari formula'}
          </button>
        </>
      )}

      {list && (
        <div style={{ ...s.card, borderTop: `3px solid ${list.status === 'COMPLETED' ? C.neo : C.amber}` }}>
          <div style={s.rowBetween}>
            <div style={s.code}>{list.doc_no}</div>
            <span style={pill(list.status === 'COMPLETED' ? 'ok' : 'warn')}>{list.status}</span>
          </div>
          <div style={s.meta}>
            {list.staging_location_id ? 'staging sudah ditetapkan' : 'staging belum ditetapkan'}
            {list.completed_at ? ` · selesai ${list.completed_at.slice(0, 16).replace('T', ' ')}` : ''}
          </div>
          {(list.status === 'COMPLETED' || list.status === 'SHORT') && (
            <button style={{ ...s.btnGhost, width: '100%', marginTop: 10, borderColor: C.neo, color: C.neo }}
                    disabled={busy} onClick={() => void consumeFromPick()}>
              {busy ? 'Mencatat…' : 'Catat konsumsi dari pick list'}
            </button>
          )}
        </div>
      )}
    </>
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
