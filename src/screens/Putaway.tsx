/**
 * Layar Tugas Put-away (P14–P16) + pemindahan bebas (P09).
 *
 * Alur scan ganda: pindai kemasan → pindai rak tujuan. Urutan itu disengaja —
 * petugas memegang barang dulu, baru mencari tempatnya. Bila rak yang dipindai
 * bukan saran sistem, alasan wajib ditulis sebelum lanjut.
 *
 * Penolakan zonasi alergen datang dari trigger database dan ditampilkan penuh
 * layar: kontaminasi silang bukan peringatan yang boleh terlewat.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import QrScanner from '../components/QrScanner';
import { parseDbError, type ScanResult } from '../lib/api';
import { listLocations, type Location } from '../lib/queries';
import {
  listPutawayTasks, completePutaway, suggestPutaway, transferHu, extractLocationCode, itemIdForLot,
  ZONE_MESSAGES, type PutawayTask, type PutawaySuggestion, type ZoneErrorCode,
} from '../lib/putaway';
import { useLabourSession } from '../lib/labour';
import SessionConflict from '../components/SessionConflict';
import { C, MONO, s, pill } from '../ui';

type Mode = { kind: 'task'; task: PutawayTask } | { kind: 'free'; scan: ScanResult };

export default function Putaway() {
  const [tasks, setTasks] = useState<PutawayTask[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [freeScan, setFreeScan] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [placed, setPlaced] = useState(0);

  // sesi kerja seumur layar; jumlah kemasan yang diletakkan jadi lines_handled
  const { conflict, resolveConflict } = useLabourSession('PUTAWAY');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [t, l] = await Promise.all([listPutawayTasks(true), listLocations()]);
      setTasks(t);
      setLocations(l);
      setErr(null);
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (mode) {
    return (
      <PlaceHu
        mode={mode}
        locations={locations}
        onBack={() => setMode(null)}
        onDone={() => { setMode(null); setPlaced((n) => n + 1); void refresh(); }}
      />
    );
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Put-away</h1>
      <p style={s.sub}>
        {tasks.length} kemasan menunggu diletakkan
        {placed > 0 ? ` · ${placed} selesai sesi ini` : ''}
      </p>
      {conflict && <SessionConflict session={conflict} onResolve={resolveConflict} />}
      {err && <div style={s.err}>{err}</div>}

      <button style={{ ...s.btnGhost, width: '100%' }} onClick={() => setFreeScan(true)}>
        Pindah stok tanpa tugas
      </button>

      <div style={s.secHead}>Tugas terbuka</div>
      {loading && <div style={s.empty}>Memuat tugas…</div>}
      {!loading && tasks.length === 0 && (
        <div style={s.empty}>Tidak ada tugas. Tugas terbit otomatis saat QA melepas lot.</div>
      )}

      {tasks.map((t) => {
        const hu = t.handling_units;
        const suggested = locations.find((l) => l.id === t.suggested_location_id);
        return (
          <button key={t.id} style={{ ...s.card, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setMode({ kind: 'task', task: t })}>
            <div style={s.rowBetween}>
              <div style={s.code}>{hu?.hu_code ?? t.doc_no}</div>
              <span style={pill(t.status === 'ASSIGNED' ? 'warn' : 'mute')}>{t.status}</span>
            </div>
            <div style={s.meta}>
              {hu?.lots?.items?.name ?? '—'} · {hu?.qty_remaining} {hu?.uom} · lot {hu?.lots?.lot_code ?? '—'}
            </div>
            <div style={{ ...s.meta, color: C.neo }}>
              → {suggested ? `${suggested.code} · ${suggested.name}` : 'tanpa saran lokasi'}
            </div>
          </button>
        );
      })}

      {freeScan && (
        <QrScanner
          action="TRANSFER"
          title="Pindai kemasan yang dipindah"
          onAccept={(r) => { setFreeScan(false); setMode({ kind: 'free', scan: r }); }}
          onClose={() => setFreeScan(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------- letakkan / pindahkan */

function PlaceHu({ mode, locations, onBack, onDone }: {
  mode: Mode; locations: Location[]; onBack: () => void; onDone: () => void;
}) {
  const isTask = mode.kind === 'task';
  const hu = isTask ? mode.task.handling_units : null;

  const huCode = isTask ? hu?.hu_code ?? '—' : mode.scan.hu_code ?? '—';
  const itemName = isTask ? hu?.lots?.items?.name ?? '—' : mode.scan.item_name ?? '—';
  const lotCode = isTask ? hu?.lots?.lot_code ?? '—' : mode.scan.lot_code ?? '—';
  const qty = isTask ? hu?.qty_remaining : mode.scan.qty_remaining;
  const uom = isTask ? hu?.uom : mode.scan.uom;

  const suggestedId = isTask ? mode.task.suggested_location_id : null;
  const suggested = useMemo(
    () => locations.find((l) => l.id === suggestedId) ?? null,
    [locations, suggestedId]
  );

  const [target, setTarget] = useState<Location | null>(suggested);
  const [reason, setReason] = useState('');
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState('');
  const [alt, setAlt] = useState<PutawaySuggestion[]>([]);
  const [zoneErr, setZoneErr] = useState<{ code: ZoneErrorCode; detail: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // alternatif lokasi hanya relevan untuk pemindahan bebas — tugas sudah punya saran
  useEffect(() => {
    if (isTask) return;
    const { lot_id, qty_remaining } = mode.scan;
    if (!lot_id || !qty_remaining) return;
    void itemIdForLot(lot_id)
      .then((id) => (id ? suggestPutaway(id, qty_remaining) : []))
      .then(setAlt)
      .catch(() => setAlt([]));
  }, [isTask, mode]);

  const deviates = Boolean(suggested && target && target.id !== suggested.id);
  const needsReason = deviates && reason.trim().length < 8;

  function pickByCode(raw: string) {
    const code = extractLocationCode(raw);
    if (!code) {
      setErr('Itu bukan label rak. Pindai label lokasi, bukan label kemasan.');
      return;
    }
    const loc = locations.find((l) => l.code.toUpperCase() === code);
    if (!loc) {
      setErr(`Kode rak ${code} tidak ada di master lokasi.`);
      return;
    }
    setErr(null);
    setTarget(loc);
    setScanning(false);
  }

  async function submit() {
    if (!target) return;
    setBusy(true);
    setErr(null);
    setZoneErr(null);
    try {
      if (isTask) {
        await completePutaway(mode.task.id, target.id, deviates ? reason.trim() : undefined);
      } else {
        if (!mode.scan.hu_id) throw new Error('Kemasan tidak dikenali.');
        await transferHu(mode.scan.hu_id, target.id);
      }
      onDone();
    } catch (e) {
      const { code, message } = e as { code: string; message: string };
      if (code in ZONE_MESSAGES) setZoneErr({ code: code as ZoneErrorCode, detail: message });
      else setErr(message || 'Gagal menyimpan.');
    } finally {
      setBusy(false);
    }
  }

  if (zoneErr) {
    const m = ZONE_MESSAGES[zoneErr.code];
    return (
      <div style={s.page}>
        <div style={{ ...s.card, borderTop: `3px solid ${C.chili}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.chili }}>{m.title}</div>
          <p style={{ fontSize: 13.5, lineHeight: 1.5, color: C.ink }}>{m.hint}</p>
          <div style={{ ...s.meta, color: C.chili }}>{zoneErr.detail}</div>
        </div>
        <button style={{ ...s.btn, background: C.chili }} onClick={() => { setZoneErr(null); setTarget(null); }}>
          Pilih rak lain
        </button>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar tugas</button>
      <h1 style={s.h1}>{isTask ? 'Letakkan kemasan' : 'Pindah stok'}</h1>
      <p style={s.sub}>{huCode} · {itemName}</p>

      <div style={s.card}>
        <dl style={kv}>
          <dt>Lot</dt><dd>{lotCode}</dd>
          <dt>Jumlah</dt><dd>{qty} {uom}</dd>
          {suggested && (<><dt>Saran rak</dt><dd style={{ color: C.neo }}>{suggested.code} · {suggested.name}</dd></>)}
        </dl>
      </div>

      {!isTask && alt.length > 0 && (
        <>
          <div style={s.secHead}>Rak yang disarankan</div>
          {alt.slice(0, 4).map((a) => (
            <button key={a.location_id}
                    style={{ ...s.card, ...s.rowBetween, width: '100%', cursor: 'pointer',
                             borderColor: target?.id === a.location_id ? C.neo : C.line }}
                    onClick={() => setTarget(locations.find((l) => l.id === a.location_id) ?? null)}>
              <div style={{ textAlign: 'left' }}>
                <div style={s.code}>{a.location_code}</div>
                <div style={s.meta}>{a.reason}</div>
              </div>
              <span style={pill('mute')}>skor {Math.round(a.score)}</span>
            </button>
          ))}
        </>
      )}

      <div style={s.secHead}>Rak tujuan</div>
      <div style={{ ...s.card, borderTop: `3px solid ${target ? C.neo : C.line}` }}>
        {target
          ? <>
              <div style={s.code}>{target.code}</div>
              <div style={s.meta}>{target.name ?? target.type}</div>
            </>
          : <div style={s.empty}>Belum dipilih. Pindai label rak atau ketik kodenya.</div>}
      </div>

      <button style={{ ...s.btnGhost, width: '100%', marginTop: 8 }} onClick={() => setScanning(true)}>
        Pindai label rak
      </button>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input style={s.input} value={manual} placeholder="atau ketik kode rak (A1-L1-01)"
               onChange={(e) => setManual(e.target.value)} />
        <button style={s.btnGhost} onClick={() => pickByCode(manual)}>Pakai</button>
      </div>

      {deviates && (
        <>
          <label style={s.label} htmlFor="dev">
            Rak berbeda dari saran — alasan wajib (minimal 8 karakter)
          </label>
          <textarea id="dev" style={{ ...s.input, resize: 'vertical' }} rows={2} value={reason}
                    placeholder="Contoh: rak saran penuh oleh lot lain yang belum dipindah"
                    onChange={(e) => setReason(e.target.value)} />
        </>
      )}

      {err && <div style={s.err}>{err}</div>}

      <button
        style={{ ...s.btn, background: deviates ? C.amber : C.neo, opacity: busy || !target || needsReason ? 0.5 : 1 }}
        disabled={busy || !target || needsReason}
        onClick={() => void submit()}
      >
        {busy ? 'Menyimpan…' : deviates ? 'Simpan dengan alasan' : 'Selesai diletakkan'}
      </button>

      {scanning && (
        <ScanLocation onCode={pickByCode} onClose={() => setScanning(false)} />
      )}
    </div>
  );
}

/**
 * Pemindai label rak. Memakai jalur manual QrScanner tidak cocok — label rak
 * bukan handling unit, jadi tidak boleh lewat resolve_qr. Kamera dibaca
 * langsung lewat BarcodeDetector, dengan input manual sebagai cadangan.
 */
function ScanLocation({ onCode, onClose }: { onCode: (raw: string) => void; onClose: () => void }) {
  const [manual, setManual] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const video = document.getElementById('loc-video') as HTMLVideoElement | null;

    const Detector = (window as unknown as {
      BarcodeDetector?: new (o: { formats: string[] }) => {
        detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]>;
      };
    }).BarcodeDetector;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false,
        });
        if (video) { video.srcObject = stream; await video.play(); }
        if (!Detector) { setErr('Browser ini tidak mendukung pemindaian. Ketik kode rak.'); return; }
        const det = new Detector({ formats: ['qr_code'] });
        const loop = async () => {
          if (stopped) return;
          if (video && video.readyState >= 2) {
            try {
              const codes = await det.detect(video);
              if (codes.length) { navigator.vibrate?.(40); onCode(codes[0].rawValue); return; }
            } catch { /* frame gagal, lanjut */ }
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch {
        setErr('Kamera tidak dapat dibuka. Ketik kode rak.');
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div style={sc.wrap}>
      <div style={sc.head}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>Pindai label rak</span>
        <button style={sc.icon} onClick={onClose} aria-label="Tutup">✕</button>
      </div>
      <div style={sc.viewport}>
        <video id="loc-video" playsInline muted style={sc.video} />
        <div style={sc.reticle} aria-hidden />
        {err && <div style={sc.msg}>{err}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, background: C.ink }}>
        <input style={{ ...s.input, background: '#0A1F17', color: C.lab, borderColor: C.slate }}
               value={manual} placeholder="ketik kode rak" onChange={(e) => setManual(e.target.value)} />
        <button style={{ ...s.btnGhost, background: C.neo, color: '#fff', borderColor: C.neo }}
                onClick={() => manual && onCode(manual)}>
          Pakai
        </button>
      </div>
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
  fontSize: 12.5, fontFamily: MONO, margin: 0,
};

const sc: Record<string, React.CSSProperties> = {
  wrap: { position: 'fixed', inset: 0, background: C.ink, color: C.lab, display: 'flex', flexDirection: 'column', zIndex: 50 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px' },
  icon: { background: 'none', border: 'none', color: C.lab, fontSize: 20, cursor: 'pointer', padding: 4 },
  viewport: { position: 'relative', flex: 1, overflow: 'hidden', background: '#000' },
  video: { width: '100%', height: '100%', objectFit: 'cover' },
  reticle: {
    position: 'absolute', top: '50%', left: '50%', width: 232, height: 232,
    transform: 'translate(-50%,-50%)', border: `3px solid ${C.amber}`, borderRadius: 8,
    boxShadow: '0 0 0 100vmax rgba(0,0,0,.45)',
  },
  msg: {
    position: 'absolute', bottom: 24, left: 0, right: 0, textAlign: 'center',
    color: '#FFB4A6', fontSize: 13, fontFamily: MONO,
  },
};
