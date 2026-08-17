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
import { recordCcp, consumeLot, consumedHuIds, createBatch, parseDbError } from '../lib/api';
import { listBatches, batchRequirements, ccpDefinitions, listItems, listFormulas, listPartners,
  type Batch, type CcpDefinition, type Item, type Formula, type Partner } from '../lib/queries';
import { listPickLists, generatePickList, pickedLines, type PickList } from '../lib/picking';
import { printLabels } from '../lib/labels';
import { C, MONO, s, pill } from '../ui';

type Requirement = { itemId: string; itemName: string; qtyNeeded: number; uom: string };

export default function Production() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<Batch | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listBatches(true)
      .then(setBatches)
      .catch((e) => setErr(parseDbError(e).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  if (open) return <BatchDetail batch={open} onBack={() => setOpen(null)} />;

  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Produksi</h1>
      <p style={s.sub}>{batches.length} batch berjalan</p>
      {err && <div style={s.err}>{err}</div>}

      {!showNew && (
        <button style={{ ...s.btn, maxWidth: 320 }} onClick={() => setShowNew(true)}>
          + Rencanakan batch baru
        </button>
      )}
      {showNew && (
        <NewBatch onCancel={() => setShowNew(false)}
                  onCreated={() => { setShowNew(false); load(); }} />
      )}

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

/* ------------------------------------------------------------ batch baru */

/**
 * Buat batch PLANNED baru. Sebelum ini tidak ada jalan lain selain insert SQL
 * manual — akibatnya Bentuk gelombang & Terbitkan pick list selalu buntu
 * ("batch harus punya formula") karena tidak ada batch berformula yang bisa
 * dibuat lewat UI sama sekali.
 */
function NewBatch({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Partner[]>([]);
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [f, setF] = useState({ itemId: '', formulaId: '', targetQty: '', customerId: '', lineCode: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    Promise.all([listItems('FINISHED'), listPartners('CUSTOMER')])
      .then(([i, c]) => { setItems(i); setCustomers(c); })
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  useEffect(() => {
    setF((p) => ({ ...p, formulaId: '' }));
    if (!f.itemId) { setFormulas([]); return; }
    listFormulas(f.itemId).then(setFormulas).catch((e) => setErr(parseDbError(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.itemId]);

  const canSubmit = f.itemId && f.formulaId && Number(f.targetQty) > 0;

  return (
    <div style={{ ...s.card, maxWidth: 480 }}>
      <div style={s.secHead}>Batch baru</div>
      {err && <div style={s.err}>{err}</div>}

      <label style={s.label} htmlFor="nb-item">Produk jadi</label>
      <select id="nb-item" style={s.input} value={f.itemId} onChange={(e) => set('itemId', e.target.value)}>
        <option value="">— pilih produk —</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
      </select>

      <label style={s.label} htmlFor="nb-formula">Formula</label>
      <select id="nb-formula" style={s.input} value={f.formulaId} disabled={!f.itemId}
              onChange={(e) => set('formulaId', e.target.value)}>
        <option value="">{f.itemId ? '— pilih formula —' : 'pilih produk dulu'}</option>
        {formulas.map((fm) => (
          <option key={fm.id} value={fm.id}>v{fm.version} · basis {fm.output_qty} · yield {fm.std_yield_pct}%</option>
        ))}
      </select>
      {f.itemId && formulas.length === 0 && (
        <div style={{ ...s.meta, color: C.amber, marginTop: 4 }}>Produk ini belum punya formula aktif.</div>
      )}

      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="nb-qty">Target qty</label>
          <input id="nb-qty" style={s.input} type="number" inputMode="decimal" step="0.001"
                 value={f.targetQty} onChange={(e) => set('targetQty', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="nb-line">Line (opsional)</label>
          <input id="nb-line" style={s.input} value={f.lineCode} onChange={(e) => set('lineCode', e.target.value)} />
        </div>
      </div>

      <label style={s.label} htmlFor="nb-cust">Pelanggan (opsional, untuk batch titipan)</label>
      <select id="nb-cust" style={s.input} value={f.customerId} onChange={(e) => set('customerId', e.target.value)}>
        <option value="">—</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <label style={s.label} htmlFor="nb-remarks">Catatan (opsional)</label>
      <textarea id="nb-remarks" style={{ ...s.input, resize: 'vertical' }} rows={2}
                value={f.remarks} onChange={(e) => set('remarks', e.target.value)} />

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={{ ...s.btnGhost, flex: 1 }} onClick={onCancel}>Batal</button>
        <button
          style={{ ...s.btn, flex: 2, opacity: busy || !canSubmit ? 0.5 : 1 }}
          disabled={busy || !canSubmit}
          onClick={() => {
            setBusy(true);
            setErr(null);
            createBatch({
              itemId: f.itemId,
              formulaId: f.formulaId,
              targetQty: Number(f.targetQty),
              customerId: f.customerId || undefined,
              lineCode: f.lineCode.trim() || undefined,
              remarks: f.remarks.trim() || undefined,
            })
              .then(onCreated)
              .catch((e) => setErr(parseDbError(e).message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Menyimpan…' : 'Rencanakan batch'}
        </button>
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

        <div style={{ ...s.card, maxWidth: 480, borderTop: `3px solid ${C.amber}` }}>
          <div style={s.code}>{result.handlingUnit.hu_code} · lot {result.lotCode}</div>
          <div style={s.meta}>
            Tugas put-away sudah terbit — cek layar Put-away untuk menaruhnya ke rak produk jadi.
          </div>
        </div>
        <button
          style={{ ...s.btnGhost, maxWidth: 480, marginTop: 10 }}
          onClick={() => void printLabels([{
            hu_code: result.handlingUnit.hu_code,
            qr_token: result.handlingUnit.qr_token,
            lot_code: result.lotCode,
            item_name: batch.items?.name ?? '',
            qty: Number(form.actualQty),
            uom: batch.items?.base_uom ?? '',
            expiry_date: result.expiryDate,
          }]).catch((e) => setErr((e as Error).message))}
        >
          Cetak label kemasan
        </button>

        <button style={{ ...s.btn, maxWidth: 320, marginTop: 10 }} onClick={onBack}>Selesai</button>
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
            batch.items?.shelf_life_days ?? 0, batch.items?.base_uom ?? 'KG'
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

  /** Catat seluruh baris terpetik sebagai konsumsi batch. Sudah tercatat → dilewati
   * (ditemukan live: komentar ini sempat tidak sesuai kode — pickedLines() tidak
   * pernah menyaring baris yang sudah tercatat, jadi mengulang tombol ini setelah
   * kegagalan sebagian akan mencatat baris yang sukses itu dua kali). */
  async function consumeFromPick() {
    if (!list) return;
    setBusy(true);
    setMsg(null);
    try {
      const [picked, already] = await Promise.all([pickedLines(list.id), consumedHuIds(batch.id)]);
      const pending = picked.filter((p) => !p.picked_hu_id || !already.has(p.picked_hu_id));
      let ok = 0;
      const failed: string[] = [];
      for (const p of pending) {
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
