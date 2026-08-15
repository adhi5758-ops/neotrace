/**
 * NEOTRACE — lembar kerja Wave Picking (Fase 3)
 *
 * Perbedaan mendasar dari pick list biasa: baris digabung per LOKASI,
 * bukan per batch. Petugas berhenti sekali di tiap rak, lalu membagi
 * ke beberapa tote sesuai batch.
 *
 * Sesi kerja dimulai dan ditutup otomatis mengikuti gelombang, supaya
 * operator tidak perlu clock in/out manual — beban tambahan adalah
 * cara tercepat membuat pencatatan produktivitas ditinggalkan.
 */
import { useCallback, useEffect, useState } from 'react';
import QrScanner from './QrScanner';
import type { ScanResult } from '../lib/api';
import { confirmPick } from '../lib/picking';
import {
  getWaveSheet, startLabour, endLabour, waveMessage, type WaveStop,
} from '../lib/api-phase3';

interface Props { waveId: string; waveNo: string; onFinish?: () => void }

export default function WavePickSheet({ waveId, waveNo, onFinish }: Props) {
  const [stops, setStops] = useState<WaveStop[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [scanning, setScanning] = useState<WaveStop | null>(null);
  const [splitting, setSplitting] = useState<{ stop: WaveStop; scan: ScanResult } | null>(null);
  const [err, setErr] = useState<{ title: string; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void getWaveSheet(waveId).then(setStops).catch(() => setStops([]));
  }, [waveId]);
  useEffect(refresh, [refresh]);

  // sesi kerja mengikuti umur komponen
  useEffect(() => {
    let id: string | null = null;
    void startLabour('PICK', waveId, waveNo)
      .then((s) => { id = s; setSession(s); })
      .catch((e) => setErr(waveMessage((e as { code: string }).code)));
    return () => { if (id) void endLabour(id); };
  }, [waveId, waveNo]);

  const doneCount = stops.filter((s) => s.all_done).length;
  const nextStop = stops.find((s) => !s.all_done);
  const allDone = stops.length > 0 && doneCount === stops.length;

  async function onScan(scan: ScanResult) {
    const stop = scanning;
    setScanning(null);
    if (!stop) return;
    if (!scan.ok || scan.item_name !== stop.item_name) {
      setErr({ title: 'Bahan tidak sesuai', hint: 'Kemasan ini bukan bahan pada perhentian ini.' });
      return;
    }
    const open = stop.splits.filter((s) => s.status === 'OPEN' || s.status === 'ASSIGNED');
    if (open.length === 1) {
      await confirmSplit(stop, scan, open[0].line_id, open[0].qty);
    } else {
      setSplitting({ stop, scan });   // lebih dari satu tote → operator memilih
    }
  }

  async function confirmSplit(stop: WaveStop, scan: ScanResult, lineId: string, qty: number) {
    setBusy(true);
    try {
      await confirmPick(lineId, scan.hu_id!, qty);
      setSplitting(null);
      refresh();
    } catch (e) {
      const { code, message } = e as { code: string; message: string };
      const m = waveMessage(code);
      setErr({ title: m.title, hint: code === 'UNKNOWN' ? message : m.hint });
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (session) await endLabour(session, undefined, stops.length);
    onFinish?.();
  }

  if (scanning)
    return (
      <QrScanner
        action="PICK"
        title={`Ambil ${scanning.item_name}`}
        onAccept={onScan}
        onClose={() => setScanning(null)}
      />
    );

  return (
    <div style={s.wrap}>
      <header style={s.head}>
        <div>
          <div style={s.wave}>{waveNo}</div>
          <div style={s.sub}>{stops.length} perhentian · {new Set(stops.flatMap((x) => x.splits.map((y) => y.batch))).size} batch</div>
        </div>
        <div style={s.prog}>
          <div style={s.progNum}>{doneCount}<span style={s.progOf}>/{stops.length}</span></div>
          <div style={s.progLbl}>rak</div>
        </div>
      </header>

      <div style={s.bar}><div style={{ ...s.barFill, width: `${stops.length ? (doneCount / stops.length) * 100 : 0}%` }} /></div>

      {stops.map((st) => {
        const isNext = nextStop?.wave_sequence === st.wave_sequence;
        return (
          <div key={st.wave_sequence} style={{
            ...s.stop,
            borderLeft: `4px solid ${st.all_done ? C.neo : isNext ? C.ink : 'transparent'}`,
            opacity: st.all_done ? 0.5 : 1,
          }}>
            <div style={s.stopHead}>
              <div>
                <div style={s.loc}>{st.location_code ?? '—'}</div>
                <div style={s.itemName}>{st.item_name}</div>
                <div style={s.meta}>{st.lot_code ?? '—'}{st.hu_code ? ` · ${st.hu_code}` : ''}</div>
              </div>
              <div style={s.totalQty}>{st.total_qty}<small style={s.uom}>{st.uom}</small></div>
            </div>

            <div style={s.splits}>
              {st.splits.map((sp) => (
                <div key={sp.line_id} style={{
                  ...s.split,
                  borderColor: sp.status === 'COMPLETED' ? C.neo : C.line,
                  color: sp.status === 'COMPLETED' ? C.neo : C.ink,
                }}>
                  <b style={s.tote}>{sp.tote}</b>
                  <span style={s.splitBatch}>{sp.batch}</span>
                  <span style={s.splitQty}>{sp.qty} {st.uom}</span>
                  {sp.status === 'COMPLETED' && <span>✓</span>}
                </div>
              ))}
            </div>

            {!st.all_done && (
              <button style={{ ...s.pickBtn, background: isNext ? C.neo : 'transparent',
                               color: isNext ? '#fff' : C.ink,
                               border: isNext ? 'none' : `1px solid ${C.line}` }}
                      onClick={() => setScanning(st)}>
                Pindai di {st.location_code}
              </button>
            )}
          </div>
        );
      })}

      {allDone && (
        <div style={s.doneBox}>
          <div style={s.doneTitle}>Gelombang selesai</div>
          <p style={s.hint}>Antar tote ke area staging masing-masing batch.</p>
          <button style={s.cta} onClick={() => void finish()}>Tutup gelombang</button>
        </div>
      )}

      {splitting && (
        <Sheet title="Bagi ke tote mana?" onClose={() => setSplitting(null)}>
          <p style={s.hint}>
            Perhentian ini melayani beberapa batch. Pilih tote yang sedang diisi.
          </p>
          {splitting.stop.splits
            .filter((sp) => sp.status === 'OPEN' || sp.status === 'ASSIGNED')
            .map((sp) => (
              <button key={sp.line_id} style={s.toteBtn} disabled={busy}
                      onClick={() => void confirmSplit(splitting.stop, splitting.scan, sp.line_id, sp.qty)}>
                <b style={s.toteBig}>{sp.tote}</b>
                <span style={s.splitBatch}>{sp.batch}</span>
                <span style={s.splitQty}>{sp.qty} {splitting.stop.uom}</span>
              </button>
            ))}
        </Sheet>
      )}

      {err && (
        <Sheet title={err.title} accent={C.chili} onClose={() => setErr(null)}>
          <p style={s.hint}>{err.hint}</p>
          <button style={{ ...s.cta, background: C.chili }} onClick={() => setErr(null)}>Mengerti</button>
        </Sheet>
      )}
    </div>
  );
}

function Sheet({ title, accent = '#1B7A4B', onClose, children }:
  { title: string; accent?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={s.sheetWrap} role="dialog" aria-modal="true">
      <div style={{ ...s.sheet, borderTop: `5px solid ${accent}` }}>
        <div style={s.sheetHead}>
          <span style={{ ...s.sheetTitle, color: accent }}>{title}</span>
          <button style={s.iconBtn} onClick={onClose} aria-label="Tutup">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const C = { ink: '#0E2A20', neo: '#1B7A4B', amber: '#D0870A', chili: '#C13A22', line: '#CFDAD4', slate: '#6A7F76', lab: '#EEF3F0' };

const s: Record<string, React.CSSProperties> = {
  wrap: { padding: 16, background: C.lab, minHeight: '100%', fontFamily: 'Archivo, system-ui, sans-serif', color: C.ink },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  wave: { fontFamily: 'monospace', fontSize: 16, fontWeight: 600 },
  sub: { fontFamily: 'monospace', fontSize: 11, color: C.slate, marginTop: 4 },
  prog: { textAlign: 'right', flex: 'none' },
  progNum: { fontFamily: 'monospace', fontSize: 22, fontWeight: 600, lineHeight: 1 },
  progOf: { fontSize: 13, color: C.slate },
  progLbl: { fontFamily: 'monospace', fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: C.slate, marginTop: 3 },
  bar: { height: 4, background: C.line, marginBottom: 16 },
  barFill: { height: '100%', background: C.neo, transition: 'width .25s' },
  stop: { background: '#fff', border: `1px solid ${C.line}`, padding: '13px 14px', marginBottom: 10 },
  stopHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  loc: { fontFamily: 'monospace', fontSize: 17, fontWeight: 600, letterSpacing: '.03em' },
  itemName: { fontSize: 13.5, fontWeight: 700, marginTop: 4 },
  meta: { fontFamily: 'monospace', fontSize: 10, color: C.slate, marginTop: 3 },
  totalQty: { fontFamily: 'monospace', fontSize: 17, fontWeight: 600, textAlign: 'right', flex: 'none' },
  uom: { display: 'block', fontSize: 9, color: C.slate, fontWeight: 400 },
  splits: { display: 'flex', flexDirection: 'column', gap: 5, margin: '11px 0' },
  split: { display: 'flex', alignItems: 'center', gap: 9, border: '1px solid', padding: '7px 10px', fontSize: 12 },
  tote: { fontFamily: 'monospace', fontSize: 12, letterSpacing: '.04em' },
  splitBatch: { fontFamily: 'monospace', fontSize: 11, color: C.slate, flex: 1 },
  splitQty: { fontFamily: 'monospace', fontSize: 12, fontWeight: 600 },
  pickBtn: { width: '100%', padding: '11px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  doneBox: { background: '#fff', border: `1px solid ${C.neo}`, borderLeft: `4px solid ${C.neo}`, padding: 15, marginTop: 12 },
  doneTitle: { fontSize: 15, fontWeight: 800, color: C.neo, marginBottom: 6 },
  hint: { fontSize: 12.5, color: C.slate, lineHeight: 1.5, marginBottom: 12 },
  cta: { width: '100%', padding: 15, background: C.neo, color: '#fff', border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  sheetWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'flex-end', zIndex: 60 },
  sheet: { width: '100%', background: '#fff', padding: '18px 18px 24px', maxHeight: '80vh', overflowY: 'auto' },
  sheetHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sheetTitle: { fontSize: 16, fontWeight: 800 },
  iconBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.slate },
  toteBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px', background: '#fff', border: `1px solid ${C.line}`, marginBottom: 8, cursor: 'pointer', fontFamily: 'inherit' },
  toteBig: { fontFamily: 'monospace', fontSize: 15, fontWeight: 600 },
};
