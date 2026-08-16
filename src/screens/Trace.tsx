/**
 * Konsol telusur dua arah.
 *   maju   : lot bahan → batch → produk jadi → pelanggan (untuk recall)
 *   mundur : batch → seluruh lot bahan yang masuk (untuk komplain pelanggan)
 * Ditambah saldo bahan titipan klien, karena itu yang direkonsiliasi tiap bulan.
 */
import { useEffect, useState } from 'react';
import { traceForward, traceBackward, consignmentBalance, parseDbError } from '../lib/api';
import {
  searchLots, lotHandlingUnits, listBatches,
  type LotRow, type TraceForwardRow, type ConsignmentRow, type Batch,
} from '../lib/queries';
import { C, MONO, s, pill, lotTone } from '../ui';

type Tab = 'lot' | 'batch' | 'titipan';

export default function Trace() {
  const [tab, setTab] = useState<Tab>('lot');
  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Telusur</h1>
      <p style={s.sub}>Bukti dua arah untuk audit, recall, dan komplain</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 240px))', gap: 6, marginBottom: 8 }}>
        {([['lot', 'Lot → produk'], ['batch', 'Batch → bahan'], ['titipan', 'Saldo titipan']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
                  style={{ ...s.btnGhost, fontSize: 11, fontFamily: MONO, padding: '10px 6px',
                           borderColor: tab === k ? C.neo : C.line, color: tab === k ? C.neo : C.slate }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'lot' && <ForwardTrace />}
      {tab === 'batch' && <BackwardTrace />}
      {tab === 'titipan' && <Consignment />}
    </div>
  );
}

/* ------------------------------------------------------------------ maju */

function ForwardTrace() {
  const [q, setQ] = useState('');
  const [lots, setLots] = useState<LotRow[]>([]);
  const [sel, setSel] = useState<LotRow | null>(null);
  const [rows, setRows] = useState<TraceForwardRow[]>([]);
  const [hus, setHus] = useState<Awaited<ReturnType<typeof lotHandlingUnits>>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setSel(null);
    try { setLots(await searchLots(q.trim())); }
    catch (ex) { setErr(parseDbError(ex).message); }
    finally { setBusy(false); }
  }

  async function pick(lot: LotRow) {
    setSel(lot); setBusy(true); setErr(null);
    try {
      const [f, h] = await Promise.all([traceForward(lot.id), lotHandlingUnits(lot.id)]);
      setRows((f ?? []) as unknown as TraceForwardRow[]);
      setHus(h);
    } catch (ex) { setErr(parseDbError(ex).message); }
    finally { setBusy(false); }
  }

  // satu batch bisa muncul beberapa kali (satu baris per DO) — kelompokkan
  const batches = [...new Map(rows.map((r) => [r.batch_id, r])).values()];

  return (
    <>
      <form onSubmit={search} style={{ display: 'flex', gap: 6, maxWidth: 480 }}>
        <input style={s.input} value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="kode lot atau nama bahan" />
        <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }} disabled={busy}>Cari</button>
      </form>
      {err && <div style={s.err}>{err}</div>}

      {!sel && (
        <div style={s.cardGrid}>
          {lots.map((l) => (
            <button key={l.id} style={{ ...s.card, marginBottom: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => void pick(l)}>
              <div style={s.rowBetween}>
                <div style={s.code}>{l.lot_code}</div>
                <span style={pill(lotTone(l.status))}>{l.status}</span>
              </div>
              <div style={s.meta}>
                {l.items?.name} · exp {l.expiry_date ?? '—'} · {l.partners?.name ?? 'produksi internal'}
                {l.owner_type === 'CONSIGNED' ? ' · TITIPAN' : ''}
              </div>
            </button>
          ))}
        </div>
      )}
      {!sel && !busy && lots.length === 0 && q && <div style={s.empty}>Tidak ada lot cocok.</div>}

      {sel && (
        <>
          <button style={{ ...s.btnGhost, margin: '12px 0' }} onClick={() => setSel(null)}>‹ Hasil pencarian</button>
          <div style={{ ...s.card, maxWidth: 480, borderTop: `3px solid ${C.neo}` }}>
            <div style={s.code}>{sel.lot_code}</div>
            <div style={s.meta}>
              {sel.items?.name} · diterima {sel.qty_received} {sel.items?.base_uom} · exp {sel.expiry_date ?? '—'}
              {sel.unit_cost != null ? ` · Rp ${Number(sel.unit_cost).toLocaleString('id-ID')}/${sel.items?.base_uom}` : ''}
            </div>
          </div>

          <div style={s.secHead}>Kemasan lot ini</div>
          {hus.length === 0 && <div style={s.empty}>Tidak ada handling unit.</div>}
          <div style={s.cardGrid}>
            {hus.map((h) => (
              <div key={h.id} style={{ ...s.card, ...s.rowBetween, marginBottom: 0 }}>
                <div>
                  <div style={s.code}>{h.hu_code}</div>
                  <div style={s.meta}>{h.locations?.code ?? 'lokasi —'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={s.code}>{h.qty_remaining} {h.uom}</div>
                  <span style={pill(h.status === 'ACTIVE' ? 'ok' : 'mute')}>{h.status}</span>
                </div>
              </div>
            ))}
          </div>

          <div style={s.secHead}>Dipakai di batch ({batches.length})</div>
          {batches.length === 0 && <div style={s.empty}>Belum dipakai produksi.</div>}
          <div style={s.cardGrid}>
            {batches.map((b) => {
              const shipments = rows.filter((r) => r.batch_id === b.batch_id && r.do_no);
              return (
                <div key={b.batch_id} style={{ ...s.card, marginBottom: 0 }}>
                  <div style={s.rowBetween}>
                    <div style={s.code}>{b.batch_no}</div>
                    <div style={s.code}>{b.qty_used} dipakai</div>
                  </div>
                  <div style={s.meta}>{b.product_name}</div>

                  {shipments.length === 0
                    ? <div style={{ ...s.meta, color: C.slate }}>Belum dikirim ke pelanggan.</div>
                    : shipments.map((sp, i) => (
                        <div key={i} style={shipRow}>
                          <span style={{ color: C.chili }}>→</span>
                          <span>{sp.customer_name ?? '—'}</span>
                          <span style={{ color: C.slate }}>
                            {sp.do_no} · {sp.qty_shipped} · {sp.shipped_at?.slice(0, 10) ?? 'belum kirim'} · {sp.do_status}
                          </span>
                        </div>
                      ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- mundur */

function BackwardTrace() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState('');
  const [rows, setRows] = useState<BackwardRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // batch tertutup justru yang paling sering ditelusuri saat ada komplain
  useEffect(() => {
    Promise.all([listBatches(true), listBatches(false)])
      .then(([open, closed]) => setBatches([...open, ...closed]))
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  function run(id: string) {
    setBatchId(id);
    setRows(null);
    if (!id) return;
    setBusy(true);
    setErr(null);
    void traceBackward(id)
      .then((d) => setRows((d ?? []) as unknown as BackwardRow[]))
      .catch((ex) => setErr(parseDbError(ex).message))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <div style={{ maxWidth: 480 }}>
        <label style={s.label} htmlFor="batch">Batch produksi</label>
        <select id="batch" style={s.input} value={batchId} onChange={(e) => run(e.target.value)}>
          <option value="">— pilih batch —</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.batch_no} · {b.items?.name} · {b.status}
            </option>
          ))}
        </select>
      </div>

      {err && <div style={s.err}>{err}</div>}
      {busy && <div style={s.empty}>Menelusuri…</div>}
      {rows && rows.length === 0 && <div style={s.empty}>Batch tidak mengonsumsi bahan apa pun.</div>}

      {rows && rows.length > 0 && <div style={s.secHead}>{rows.length} lot bahan masuk batch ini</div>}
      <div style={s.cardGrid}>
        {rows?.map((r, i) => (
          <div key={i} style={{ ...s.card, marginBottom: 0 }}>
            <div style={s.rowBetween}>
              <div style={s.code}>{r.lots?.lot_code ?? '—'}</div>
              <div style={s.code}>{r.qty_actual} {r.uom}</div>
            </div>
            <div style={s.meta}>
              {r.items?.name ?? '—'} · exp {r.lots?.expiry_date ?? '—'} ·
              supplier {r.lots?.partners?.name ?? '—'}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Bentuk baris dari traceBackward() di api.ts — select bersarang, bukan view. */
interface BackwardRow {
  qty_actual: number;
  uom: string;
  lots: { lot_code: string; expiry_date: string | null; partners: { name: string } | null } | null;
  items: { name: string } | null;
}

/* --------------------------------------------------------------- titipan */

function Consignment() {
  const [rows, setRows] = useState<ConsignmentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void consignmentBalance()
      .then((d) => setRows((d ?? []) as unknown as ConsignmentRow[]))
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  // kelompokkan per klien: rekonsiliasi bulanan dilakukan per klien, bukan per item
  const byCustomer = new Map<string, ConsignmentRow[]>();
  for (const r of rows ?? []) {
    const list = byCustomer.get(r.customer_name) ?? [];
    list.push(r);
    byCustomer.set(r.customer_name, list);
  }

  return (
    <>
      {err && <div style={s.err}>{err}</div>}
      {rows === null && !err && <div style={s.empty}>Memuat saldo…</div>}
      {rows?.length === 0 && <div style={s.empty}>Tidak ada bahan titipan tercatat.</div>}

      <div style={s.cardGrid}>
        {[...byCustomer.entries()].map(([customer, items]) => {
          const off = items.some((i) => Math.abs(i.qty_variance) > 0.001);
          return (
            <div key={customer} style={{ ...s.card, marginBottom: 0, borderTop: `3px solid ${off ? C.amber : C.neo}` }}>
              <div style={s.rowBetween}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{customer}</div>
                {off && <span style={pill('warn')}>ADA SELISIH</span>}
              </div>
              {items.map((i) => (
                <div key={i.item_code} style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8, marginTop: 8 }}>
                  <div style={s.code}>{i.item_code} · {i.item_name}</div>
                  <dl style={kv}>
                    <dt>Diterima</dt><dd>{fmt(i.qty_received)}</dd>
                    <dt>Terpakai</dt><dd>{fmt(i.qty_consumed)}</dd>
                    <dt>Sisa fisik</dt><dd>{fmt(i.qty_on_hand)}</dd>
                    <dt>Selisih</dt>
                    <dd style={{ color: Math.abs(i.qty_variance) > 0.001 ? C.amber : C.neo }}>
                      {fmt(i.qty_variance)}
                    </dd>
                  </dl>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('id-ID', { maximumFractionDigits: 3 });

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px',
  fontSize: 12, fontFamily: MONO, margin: '6px 0 0',
};

const shipRow: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: 8,
  fontFamily: MONO, fontSize: 11, marginTop: 8, alignItems: 'baseline',
};
