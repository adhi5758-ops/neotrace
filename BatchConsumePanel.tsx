/**
 * NEOTRACE — layar Produksi (contoh integrasi)
 *
 * Menunjukkan pola yang dipakai di seluruh aplikasi:
 *   1. Sistem menyarankan lot berdasarkan FEFO
 *   2. Operator memindai kemasan fisik untuk konfirmasi
 *   3. Bila lot yang dipindai bukan saran sistem, wajib alasan tertulis
 *   4. Kegagalan jaringan masuk antrean offline, bukan hilang
 */
import { useEffect, useState } from 'react';
import QrScanner from './QrScanner';
import {
  suggestLotsFefo, consumeLot, closeBatch, parseDbError,
  type FefoSuggestion, type ScanResult,
} from '../lib/api';
import { enqueue, pendingCount, startAutoFlush } from '../lib/offlineQueue';

interface Props {
  batchId: string;
  itemId: string;          // bahan yang sedang diambil
  itemName: string;
  qtyNeeded: number;
  uom: string;
  locationId?: string;
}

export default function BatchConsumePanel({
  batchId, itemId, itemName, qtyNeeded, uom, locationId,
}: Props) {
  const [suggestions, setSuggestions] = useState<FefoSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);
  const [confirmed, setConfirmed] = useState<{ lotCode: string; qty: number }[]>([]);
  const [override, setOverride] = useState<{ scan: ScanResult; reason: string } | null>(null);
  const [queued, setQueued] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void suggestLotsFefo(itemId, qtyNeeded).then(setSuggestions).catch(() => setSuggestions([]));
  }, [itemId, qtyNeeded]);

  useEffect(() => {
    void pendingCount().then(setQueued);
    return startAutoFlush(async (item) => {
      if (item.kind === 'CONSUME') {
        await consumeLot(item.payload as never);
      }
      void pendingCount().then(setQueued);
    });
  }, []);

  /** Apakah kemasan yang dipindai termasuk saran FEFO? */
  const isSuggested = (r: ScanResult) => suggestions.some((s) => s.hu_id === r.hu_id);

  async function record(r: ScanResult, reason?: string) {
    const payload = {
      batchId, itemId,
      lotId: r.lot_id!,
      huId: r.hu_id,
      qtyActual: Math.min(r.qty_remaining ?? 0, qtyNeeded),
      uom,
      fefoOverride: !!reason,
      overrideReason: reason,
    };
    setBusy(true);
    try {
      await consumeLot(payload);
      setConfirmed((c) => [...c, { lotCode: r.lot_code!, qty: payload.qtyActual }]);
      setMsg(null);
    } catch (e) {
      const { code, message } = e as { code: string; message: string };
      if (code === 'UNKNOWN' && !navigator.onLine) {
        await enqueue('CONSUME', payload);
        void pendingCount().then(setQueued);
        setConfirmed((c) => [...c, { lotCode: r.lot_code!, qty: payload.qtyActual }]);
        setMsg('Tidak ada sinyal — tersimpan di HP, akan terkirim otomatis.');
      } else {
        setMsg(message || parseDbError(e).message);
      }
    } finally {
      setBusy(false);
      setOverride(null);
    }
  }

  function onScanAccepted(r: ScanResult) {
    setScanning(false);
    if (isSuggested(r)) void record(r);
    else setOverride({ scan: r, reason: '' });   // butuh alasan sebelum lanjut
  }

  const totalTaken = confirmed.reduce((a, c) => a + c.qty, 0);
  const remaining = Math.max(0, qtyNeeded - totalTaken);

  return (
    <div style={s.wrap}>
      <header style={s.head}>
        <div>
          <div style={s.item}>{itemName}</div>
          <div style={s.sub}>Perlu {qtyNeeded} {uom} · sisa {remaining.toFixed(1)} {uom}</div>
        </div>
        {queued > 0 && <span style={s.badge}>{queued} menunggu sinyal</span>}
      </header>

      <div style={s.secHead}>Saran FEFO</div>
      {suggestions.length === 0 && <div style={s.empty}>Tidak ada stok siap pakai untuk bahan ini.</div>}
      {suggestions.map((sg) => {
        const done = confirmed.some((c) => c.lotCode === sg.lot_code);
        return (
          <div key={sg.hu_id} style={{ ...s.row, opacity: done ? 0.45 : 1 }}>
            <div style={s.tick}>{done ? '✓' : ''}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={s.lot}>{sg.lot_code}</div>
              <div style={s.meta}>
                {sg.hu_code} · exp {sg.expiry_date ?? '—'} · {sg.location_code ?? '—'}
              </div>
            </div>
            <div style={s.qty}>{sg.suggested_qty.toFixed(1)}<small style={s.uom}>{uom}</small></div>
          </div>
        );
      })}

      {msg && <div style={s.msg}>{msg}</div>}

      <button style={s.cta} disabled={busy || remaining === 0} onClick={() => setScanning(true)}>
        {remaining === 0 ? 'Kebutuhan bahan terpenuhi' : 'Pindai kemasan'}
      </button>

      {scanning && (
        <QrScanner
          action="ISSUE"
          locationId={locationId}
          title={`Ambil ${itemName}`}
          onAccept={onScanAccepted}
          onClose={() => setScanning(false)}
        />
      )}

      {override && (
        <div style={s.modalWrap} role="alertdialog" aria-modal="true">
          <div style={s.modal}>
            <div style={s.modalTitle}>Bukan lot yang disarankan</div>
            <p style={s.modalBody}>
              Sistem menyarankan lot yang lebih dekat kedaluwarsa. Kalau tetap memakai
              <b> {override.scan.lot_code}</b>, tuliskan alasannya. Alasan ini masuk catatan
              audit dan dikirim ke QA.
            </p>
            <textarea
              style={s.textarea}
              rows={3}
              value={override.reason}
              placeholder="Contoh: lot saran terkunci di rak belakang, sedang stock opname"
              onChange={(e) => setOverride({ ...override, reason: e.target.value })}
            />
            <div style={s.modalBtns}>
              <button style={{ ...s.cta, background: 'transparent', color: C.ink, border: `1px solid ${C.line}` }}
                      onClick={() => setOverride(null)}>
                Batal
              </button>
              <button
                style={{ ...s.cta, background: C.amber }}
                disabled={override.reason.trim().length < 8}
                onClick={() => void record(override.scan, override.reason.trim())}
              >
                Lanjut dengan alasan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Contoh penutupan batch — memicu perhitungan yield & HPP di database. */
export async function handleCloseBatch(
  batchId: string, itemId: string, actualQty: number, rejectQty: number, shelfLifeDays: number
) {
  const cost = await closeBatch({ batchId, itemId, actualQty, rejectQty, shelfLifeDays });
  return {
    yieldPct: cost.yield_pct as number,
    actualCostPerUom: cost.actual_cost_per_uom as number,
    standardCost: cost.standard_cost as number,
    variancePct: cost.variance_pct as number,
  };
}

const C = { ink: '#0E2A20', neo: '#1B7A4B', amber: '#D0870A', chili: '#C13A22', line: '#CFDAD4', slate: '#6A7F76', lab: '#EEF3F0' };

const s: Record<string, React.CSSProperties> = {
  wrap: { padding: 16, background: C.lab, minHeight: '100%', fontFamily: 'Archivo, system-ui, sans-serif' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 16 },
  item: { fontSize: 17, fontWeight: 700, color: C.ink },
  sub: { fontSize: 12, color: C.slate, marginTop: 3, fontFamily: 'monospace' },
  badge: { fontSize: 10, fontFamily: 'monospace', color: C.amber, border: `1px solid ${C.amber}`, padding: '3px 6px', whiteSpace: 'nowrap' },
  secHead: { fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: C.slate, fontFamily: 'monospace', marginBottom: 8 },
  row: { display: 'flex', gap: 11, alignItems: 'center', background: '#fff', border: `1px solid ${C.line}`, padding: '11px 13px', marginBottom: 8 },
  tick: { width: 21, height: 21, border: `1.5px solid ${C.slate}`, display: 'grid', placeItems: 'center', fontSize: 12, color: C.neo, fontWeight: 700, flex: 'none' },
  lot: { fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: C.ink },
  meta: { fontFamily: 'monospace', fontSize: 10, color: C.slate, marginTop: 3 },
  qty: { fontFamily: 'monospace', fontSize: 14, fontWeight: 600, color: C.ink, flex: 'none' },
  uom: { display: 'block', fontSize: 9, color: C.slate, fontWeight: 400 },
  empty: { fontSize: 12.5, color: C.slate, padding: '14px 0' },
  msg: { fontSize: 12.5, color: C.chili, background: '#fff', border: `1px solid ${C.chili}`, padding: '10px 12px', margin: '10px 0' },
  cta: { width: '100%', padding: 15, background: C.neo, color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginTop: 14 },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'flex-end', zIndex: 70 },
  modal: { width: '100%', background: '#fff', padding: '20px 18px 24px', borderTop: `5px solid ${C.amber}` },
  modalTitle: { fontSize: 17, fontWeight: 800, color: C.amber, marginBottom: 8 },
  modalBody: { fontSize: 13, color: C.ink, lineHeight: 1.5, marginBottom: 12 },
  textarea: { width: '100%', padding: 12, border: `1px solid ${C.line}`, fontSize: 14, fontFamily: 'inherit', resize: 'vertical' },
  modalBtns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
};
