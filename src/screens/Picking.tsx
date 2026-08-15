/**
 * Layar Pick List (P21, P25, P26).
 *
 * Baris tampil menurut `sequence` — urutan jalur gudang, bukan urutan formula.
 * Petugas berjalan satu arah; sistem tidak boleh menyuruhnya bolak-balik.
 *
 * Konfirmasi selalu lewat scan. Kalau kemasan yang dipindai bukan bahan yang
 * diminta, database menolak (WRONG_ITEM) — itu jaring pengaman terakhir
 * sebelum bahan salah masuk kuali.
 */
import { useCallback, useEffect, useState } from 'react';
import QrScanner from '../components/QrScanner';
import { parseDbError, type ScanResult } from '../lib/api';
import { listLocations, type Location } from '../lib/queries';
import {
  listPickLists, pickLines, confirmPick, startPicking,
  type PickList, type PickLine,
} from '../lib/picking';
import { C, MONO, s, pill } from '../ui';

const toneOf = (st: string) =>
  st === 'COMPLETED' ? 'ok' : st === 'SHORT' ? 'bad' : st === 'IN_PROGRESS' ? 'warn' : 'mute';

export default function Picking() {
  const [lists, setLists] = useState<PickList[]>([]);
  const [open, setOpen] = useState<PickList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setLists(await listPickLists(true)); setErr(null); }
    catch (e) { setErr(parseDbError(e).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (open) return <PickDetail list={open} onBack={() => { setOpen(null); void refresh(); }} />;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Pick list</h1>
      <p style={s.sub}>{lists.length} daftar ambil terbuka</p>
      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat…</div>}
      {!loading && lists.length === 0 && (
        <div style={s.empty}>Tidak ada pick list. Terbitkan dari layar Produksi.</div>
      )}

      {lists.map((p) => (
        <button key={p.id} style={{ ...s.card, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setOpen(p)}>
          <div style={s.rowBetween}>
            <div style={s.code}>{p.doc_no}</div>
            <span style={pill(toneOf(p.status))}>{p.status}</span>
          </div>
          <div style={s.meta}>
            {p.production_batches?.batch_no ?? '—'} · {p.production_batches?.items?.name ?? '—'}
            {p.production_batches ? ` · target ${p.production_batches.target_qty}` : ''}
          </div>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function PickDetail({ list, onBack }: { list: PickList; onBack: () => void }) {
  const [lines, setLines] = useState<PickLine[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [active, setActive] = useState<PickLine | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, loc] = await Promise.all([pickLines(list.id), listLocations()]);
      setLines(l);
      setLocations(loc);
      setErr(null);
    } catch (e) { setErr(parseDbError(e).message); }
    finally { setLoading(false); }
  }, [list.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void startPicking(list.id).catch(() => {}); }, [list.id]);

  const done = lines.filter((l) => l.status === 'COMPLETED').length;
  const short = lines.filter((l) => l.status === 'SHORT').length;
  const locCode = (id: string | null) => locations.find((l) => l.id === id)?.code ?? '—';

  if (active) {
    return (
      <PickLineFlow
        line={active}
        locationCode={locCode(active.from_location_id)}
        onBack={() => setActive(null)}
        onDone={() => { setActive(null); void load(); }}
      />
    );
  }

  return (
    <div style={s.page}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar pick list</button>
      <h1 style={s.h1}>{list.doc_no}</h1>
      <p style={s.sub}>
        {list.production_batches?.batch_no ?? '—'} · {done}/{lines.length} selesai
        {short > 0 ? ` · ${short} kurang` : ''}
      </p>
      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat baris…</div>}

      {lines.map((l) => {
        const settled = l.status === 'COMPLETED' || l.status === 'SHORT';
        return (
          <button key={l.id}
                  style={{ ...s.card, width: '100%', textAlign: 'left', cursor: 'pointer', opacity: settled ? 0.5 : 1 }}
                  disabled={settled}
                  onClick={() => setActive(l)}>
            <div style={s.rowBetween}>
              <div style={s.code}>
                <span style={{ color: C.slate }}>{l.sequence}</span>  {locCode(l.from_location_id)}
              </div>
              <span style={pill(toneOf(l.status))}>{l.status}</span>
            </div>
            <div style={{ ...s.meta, color: C.ink, fontSize: 13, marginTop: 6 }}>{l.items?.name ?? '—'}</div>
            <div style={s.meta}>
              lot {l.lots?.lot_code ?? '—'} · exp {l.lots?.expiry_date ?? '—'} ·
              minta {l.qty_requested} {l.uom}
              {l.qty_picked != null ? ` · diambil ${l.qty_picked}` : ''}
            </div>
            {l.fefo_override && <div style={{ ...s.meta, color: C.amber }}>FEFO dilanggar dengan alasan</div>}
            {l.short_reason && <div style={{ ...s.meta, color: C.chili }}>{l.short_reason}</div>}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- satu baris pick */

function PickLineFlow({ line, locationCode, onBack, onDone }: {
  line: PickLine; locationCode: string; onBack: () => void; onDone: () => void;
}) {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(true);
  const [qty, setQty] = useState(String(line.qty_requested));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSuggestedHu = scan?.hu_id === line.suggested_hu_id;
  const isSuggestedLot = scan?.lot_id === line.suggested_lot_id;
  const needsReason = Boolean(scan) && !isSuggestedLot;
  const qtyNum = Number(qty) || 0;
  const isShort = qtyNum > 0 && qtyNum < line.qty_requested;

  async function submit() {
    if (!scan?.hu_id) return;
    setBusy(true);
    setErr(null);
    try {
      await confirmPick({
        lineId: line.id,
        huId: scan.hu_id,
        qty: qtyNum,
        overrideReason: (needsReason || isShort) ? reason.trim() : undefined,
      });
      onDone();
    } catch (e) {
      setErr((e as { message?: string }).message ?? parseDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.page}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Baris pick</button>
      <h1 style={s.h1}>{line.items?.name}</h1>
      <p style={s.sub}>{locationCode} · minta {line.qty_requested} {line.uom}</p>

      <div style={s.card}>
        <dl style={kv}>
          <dt>Lot saran</dt><dd>{line.lots?.lot_code ?? '—'}</dd>
          <dt>Kedaluwarsa</dt><dd>{line.lots?.expiry_date ?? '—'}</dd>
          <dt>Rak</dt><dd>{locationCode}</dd>
        </dl>
      </div>

      {!scan && (
        <button style={s.btn} onClick={() => setScanning(true)}>Pindai kemasan</button>
      )}

      {scan && (
        <>
          <div style={{ ...s.card, borderTop: `3px solid ${isSuggestedLot ? C.neo : C.amber}` }}>
            <div style={s.rowBetween}>
              <div style={s.code}>{scan.hu_code}</div>
              <span style={pill(isSuggestedHu ? 'ok' : isSuggestedLot ? 'warn' : 'bad')}>
                {isSuggestedHu ? 'SESUAI SARAN' : isSuggestedLot ? 'LOT SAMA, KEMASAN LAIN' : 'LOT BERBEDA'}
              </span>
            </div>
            <div style={s.meta}>
              {scan.item_name} · lot {scan.lot_code} · exp {scan.expiry_date ?? '—'} ·
              sisa {scan.qty_remaining} {scan.uom}
            </div>
          </div>

          <label style={s.label} htmlFor="qty">Jumlah diambil ({line.uom})</label>
          <input id="qty" style={s.input} type="number" inputMode="decimal" step="0.001"
                 value={qty} onChange={(e) => setQty(e.target.value)} />
          {isShort && (
            <div style={{ ...s.meta, color: C.chili, marginTop: 6 }}>
              Kurang {(line.qty_requested - qtyNum).toFixed(3)} {line.uom} — baris ditandai SHORT dan
              produksi akan melihat kekurangannya.
            </div>
          )}

          {(needsReason || isShort) && (
            <>
              <label style={s.label} htmlFor="rsn">
                {needsReason ? 'Lot berbeda dari saran FEFO — alasan wajib' : 'Alasan kekurangan'}
              </label>
              <textarea id="rsn" style={{ ...s.input, resize: 'vertical' }} rows={2} value={reason}
                        placeholder="Contoh: lot saran tersisa 12 kg, kurang dari permintaan"
                        onChange={(e) => setReason(e.target.value)} />
            </>
          )}

          {err && <div style={s.err}>{err}</div>}

          <button
            style={{
              ...s.btn,
              background: needsReason || isShort ? C.amber : C.neo,
              opacity: busy || qtyNum <= 0 || ((needsReason || isShort) && reason.trim().length < 8) ? 0.5 : 1,
            }}
            disabled={busy || qtyNum <= 0 || ((needsReason || isShort) && reason.trim().length < 8)}
            onClick={() => void submit()}
          >
            {busy ? 'Menyimpan…' : isShort ? 'Simpan sebagai kurang' : 'Konfirmasi ambil'}
          </button>
          <button style={{ ...s.btnGhost, width: '100%', marginTop: 8 }} onClick={() => { setScan(null); setScanning(true); }}>
            Pindai kemasan lain
          </button>
        </>
      )}

      {scanning && (
        <QrScanner
          action="PICK"
          title={`Ambil ${line.items?.name ?? 'bahan'}`}
          onAccept={(r) => { setScan(r); setScanning(false); setQty(String(Math.min(r.qty_remaining ?? 0, line.qty_requested))); }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
  fontSize: 12.5, fontFamily: MONO, margin: 0,
};
