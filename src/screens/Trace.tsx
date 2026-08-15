/**
 * Konsol telusur dua arah.
 *   maju   : lot bahan → produk jadi & pelanggan mana saja (untuk recall)
 *   mundur : batch → seluruh lot bahan yang masuk (untuk komplain pelanggan)
 * Ditambah saldo bahan titipan klien, karena itu yang direkonsiliasi tiap bulan.
 */
import { useEffect, useState } from 'react';
import { traceForward, traceBackward, consignmentBalance, parseDbError } from '../lib/api';
import { searchLots, lotHandlingUnits, type LotRow } from '../lib/queries';
import { C, MONO, s, pill, lotTone } from '../ui';

type Tab = 'lot' | 'batch' | 'titipan';

export default function Trace() {
  const [tab, setTab] = useState<Tab>('lot');
  return (
    <div style={s.page}>
      <h1 style={s.h1}>Telusur</h1>
      <p style={s.sub}>Bukti dua arah untuk audit, recall, dan komplain</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 }}>
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
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
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
      setRows((f ?? []) as Record<string, unknown>[]);
      setHus(h);
    } catch (ex) { setErr(parseDbError(ex).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <form onSubmit={search} style={{ display: 'flex', gap: 6 }}>
        <input style={s.input} value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="kode lot atau nama bahan" />
        <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }} disabled={busy}>Cari</button>
      </form>
      {err && <div style={s.err}>{err}</div>}

      {!sel && lots.map((l) => (
        <button key={l.id} style={{ ...s.card, width: '100%', textAlign: 'left', cursor: 'pointer' }}
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
      {!sel && !busy && lots.length === 0 && q && <div style={s.empty}>Tidak ada lot cocok.</div>}

      {sel && (
        <>
          <button style={{ ...s.btnGhost, margin: '12px 0' }} onClick={() => setSel(null)}>‹ Hasil pencarian</button>
          <div style={{ ...s.card, borderTop: `3px solid ${C.neo}` }}>
            <div style={s.code}>{sel.lot_code}</div>
            <div style={s.meta}>
              {sel.items?.name} · diterima {sel.qty_received} {sel.items?.base_uom} · exp {sel.expiry_date ?? '—'}
              {sel.unit_cost != null ? ` · Rp ${Number(sel.unit_cost).toLocaleString('id-ID')}/${sel.items?.base_uom}` : ''}
            </div>
          </div>

          <div style={s.secHead}>Kemasan lot ini</div>
          {hus.length === 0 && <div style={s.empty}>Tidak ada handling unit.</div>}
          {hus.map((h) => (
            <div key={h.id} style={{ ...s.card, ...s.rowBetween }}>
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

          <div style={s.secHead}>Produk jadi dari lot ini</div>
          {rows.length === 0 && <div style={s.empty}>Belum dipakai produksi.</div>}
          {rows.map((r, i) => (
            <div key={i} style={s.card}>
              <pre style={pre}>{JSON.stringify(r, null, 1)}</pre>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- mundur */

function BackwardTrace() {
  const [batchId, setBatchId] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <>
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          void traceBackward(batchId.trim())
            .then((d) => setRows((d ?? []) as Record<string, unknown>[]))
            .catch((ex) => setErr(parseDbError(ex).message));
        }}
      >
        <input style={s.input} value={batchId} onChange={(e) => setBatchId(e.target.value)}
               placeholder="UUID batch produksi" />
        <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }}>Telusur</button>
      </form>
      {err && <div style={s.err}>{err}</div>}
      {rows && rows.length === 0 && <div style={s.empty}>Batch tidak mengonsumsi bahan apa pun.</div>}
      {rows?.map((r, i) => (
        <div key={i} style={s.card}><pre style={pre}>{JSON.stringify(r, null, 1)}</pre></div>
      ))}
    </>
  );
}

/* --------------------------------------------------------------- titipan */

function Consignment() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void consignmentBalance()
      .then((d) => setRows((d ?? []) as Record<string, unknown>[]))
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  return (
    <>
      {err && <div style={s.err}>{err}</div>}
      {rows === null && !err && <div style={s.empty}>Memuat saldo…</div>}
      {rows?.length === 0 && <div style={s.empty}>Tidak ada bahan titipan tercatat.</div>}
      {rows?.map((r, i) => (
        <div key={i} style={s.card}><pre style={pre}>{JSON.stringify(r, null, 1)}</pre></div>
      ))}
    </>
  );
}

// ponytail: view v_trace_forward / v_consignment_balance bentuk kolomnya
// ditentukan skema v1 yang belum ada di repo ini — tampilkan apa adanya dulu,
// ganti jadi tabel berkolom begitu skema v1 masuk.
const pre: React.CSSProperties = {
  fontFamily: MONO, fontSize: 11, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.ink,
};
