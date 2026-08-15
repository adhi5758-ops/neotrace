/**
 * NEOTRACE — komponen pemindai QR
 *
 * Dua jalur deteksi:
 *   1. BarcodeDetector API (Chrome/Android, paling cepat, tanpa dependensi)
 *   2. @zxing/browser sebagai cadangan (iOS Safari, browser lama)
 *
 * Perilaku yang disengaja: hasil scan bermasalah (kedaluwarsa, halal habis,
 * belum lolos QC) ditampilkan sebagai panel merah yang MENUTUP kamera dan
 * wajib ditutup manual. Operator tidak boleh bisa memindai berikutnya
 * secara refleks tanpa membaca peringatan.
 *
 * npm i @zxing/browser
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveQr, extractToken, SCAN_MESSAGES,
  type ScanAction, type ScanResult, type ScanErrorCode,
} from '../lib/api';

/* ------------------------------------------------------------------ hook */

interface UseScannerOpts {
  action?: ScanAction;
  locationId?: string;
  deviceId?: string;
  onResult: (r: ScanResult) => void;
  cooldownMs?: number;
}

export function useScanner({
  action = 'LOOKUP', locationId, deviceId, onResult, cooldownMs = 1500,
}: UseScannerOpts) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);

  const handleCode = useCallback(async (raw: string) => {
    const now = Date.now();
    if (raw === lastRef.current.code && now - lastRef.current.at < cooldownMs) return;
    lastRef.current = { code: raw, at: now };

    const token = extractToken(raw);
    if (!token) {
      onResult({ ok: false, error: 'NOT_FOUND' });
      navigator.vibrate?.([80, 60, 80]);
      return;
    }
    try {
      const r = await resolveQr(token, action, locationId, deviceId);
      navigator.vibrate?.(r.ok ? 40 : [80, 60, 80]);
      onResult(r);
    } catch {
      // offline atau server tidak terjangkau — jangan diam-diam dianggap valid
      onResult({ ok: false, error: 'OFFLINE' });
      navigator.vibrate?.([80, 60, 80]);
    }
  }, [action, locationId, deviceId, onResult, cooldownMs]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setActive(true);

      const Detector = (window as unknown as {
        BarcodeDetector?: new (o: { formats: string[] }) => {
          detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]>;
        };
      }).BarcodeDetector;

      if (Detector) {
        const det = new Detector({ formats: ['qr_code'] });
        const loop = async () => {
          if (videoRef.current && videoRef.current.readyState >= 2) {
            try {
              const codes = await det.detect(videoRef.current);
              if (codes.length) await handleCode(codes[0].rawValue);
            } catch { /* frame gagal, lanjut */ }
          }
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      } else {
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        const reader = new BrowserQRCodeReader();
        await reader.decodeFromVideoElement(videoRef.current!, (res) => {
          if (res) void handleCode(res.getText());
        });
      }
    } catch (e) {
      setError(
        (e as Error).name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Aktifkan lewat pengaturan browser.'
          : 'Kamera tidak dapat dibuka.'
      );
    }
  }, [handleCode]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActive(false);
    setTorch(false);
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: !torch } as MediaTrackConstraintSet],
      });
      setTorch((t) => !t);
    } catch { /* perangkat tidak punya lampu */ }
  }, [torch]);

  useEffect(() => stop, [stop]);

  return { videoRef, active, error, torch, start, stop, toggleTorch, handleCode };
}

/* ------------------------------------------------------------- komponen */

interface ScannerProps {
  action?: ScanAction;
  locationId?: string;
  deviceId?: string;
  title?: string;
  onAccept: (r: ScanResult) => void;
  onClose?: () => void;
}

export default function QrScanner({
  action = 'LOOKUP', locationId, deviceId, title = 'Pindai label', onAccept, onClose,
}: ScannerProps) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState('');
  const { videoRef, active, error, torch, start, stop, toggleTorch, handleCode } =
    useScanner({ action, locationId, deviceId, onResult: setResult });

  useEffect(() => { void start(); }, [start]);

  const dismiss = () => setResult(null);
  const accept = () => { if (result?.ok) { stop(); onAccept(result); } };

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <span style={S.title}>{title}</span>
        <button style={S.iconBtn} onClick={() => { stop(); onClose?.(); }} aria-label="Tutup">✕</button>
      </div>

      <div style={S.viewport}>
        <video ref={videoRef} playsInline muted style={S.video} />
        <div style={S.reticle} aria-hidden />
        {!active && !error && <div style={S.overlayMsg}>Membuka kamera…</div>}
        {error && <div style={{ ...S.overlayMsg, color: '#FFB4A6' }}>{error}</div>}
        <button style={S.torch} onClick={toggleTorch} aria-pressed={torch}>
          {torch ? 'Lampu mati' : 'Lampu nyala'}
        </button>
      </div>

      <div style={S.manualRow}>
        <input
          style={S.input}
          value={manual}
          placeholder="Ketik kode label bila QR rusak"
          onChange={(e) => setManual(e.target.value)}
          inputMode="text"
        />
        <button style={S.smallBtn} onClick={() => manual && handleCode(manual)}>Cari</button>
      </div>

      {result && <ResultSheet result={result} onDismiss={dismiss} onAccept={accept} />}
    </div>
  );
}

/* ------------------------------------------------------------- panel hasil */

function ResultSheet({
  result, onDismiss, onAccept,
}: { result: ScanResult; onDismiss: () => void; onAccept: () => void }) {
  const bad = !result.ok;
  const msg = bad ? SCAN_MESSAGES[(result.error ?? 'NOT_FOUND') as ScanErrorCode] : null;

  return (
    <div style={S.sheetWrap} role="alertdialog" aria-modal="true">
      <div style={{ ...S.sheet, borderTop: `5px solid ${bad ? C.chili : C.neo}` }}>
        {bad ? (
          <>
            <div style={{ ...S.sheetTitle, color: C.chili }}>{msg?.title}</div>
            <p style={S.sheetHint}>{msg?.hint}</p>
            {result.lot_code && (
              <div style={S.kv}>
                <span>Lot</span><b>{result.lot_code}</b>
                <span>Bahan</span><b>{result.item_name ?? '—'}</b>
                {result.expiry_date && (<><span>Kedaluwarsa</span><b>{result.expiry_date}</b></>)}
                {result.halal_valid_until && (<><span>Halal s/d</span><b>{result.halal_valid_until}</b></>)}
              </div>
            )}
            <button style={{ ...S.bigBtn, background: C.chili }} onClick={onDismiss}>
              Saya mengerti
            </button>
          </>
        ) : (
          <>
            <div style={{ ...S.sheetTitle, color: C.neo }}>{result.item_name}</div>
            <div style={S.kv}>
              <span>Lot</span><b>{result.lot_code}</b>
              <span>Kemasan</span><b>{result.hu_code}</b>
              <span>Sisa</span><b>{result.qty_remaining} {result.uom}</b>
              <span>Kedaluwarsa</span><b>{result.expiry_date ?? '—'}</b>
              <span>Lokasi</span><b>{result.location_code ?? '—'}</b>
              {result.owner_type === 'CONSIGNED' && (
                <><span>Pemilik</span><b style={{ color: C.amber }}>Titipan · {result.owner_name}</b></>
              )}
              {!!result.allergens?.length && (
                <><span>Alergen</span><b style={{ color: C.amber }}>{result.allergens.join(', ')}</b></>
              )}
            </div>
            <div style={S.btnRow}>
              <button style={{ ...S.bigBtn, background: 'transparent', color: C.ink, border: `1px solid ${C.line}` }}
                      onClick={onDismiss}>
                Pindai lagi
              </button>
              <button style={{ ...S.bigBtn, background: C.neo }} onClick={onAccept}>
                Pakai kemasan ini
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- style */

const C = {
  ink: '#0E2A20', neo: '#1B7A4B', chili: '#C13A22',
  amber: '#D0870A', lab: '#EEF3F0', line: '#CFDAD4', slate: '#6A7F76',
};

const S: Record<string, React.CSSProperties> = {
  wrap: { position: 'fixed', inset: 0, background: C.ink, display: 'flex', flexDirection: 'column', zIndex: 50 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', color: C.lab },
  title: { fontWeight: 700, fontSize: 16 },
  iconBtn: { background: 'none', border: 'none', color: C.lab, fontSize: 20, cursor: 'pointer', padding: 4 },
  viewport: { position: 'relative', flex: 1, overflow: 'hidden', background: '#000' },
  video: { width: '100%', height: '100%', objectFit: 'cover' },
  reticle: {
    position: 'absolute', top: '50%', left: '50%', width: 232, height: 232,
    transform: 'translate(-50%,-50%)', border: `3px solid ${C.neo}`, borderRadius: 8,
    boxShadow: '0 0 0 100vmax rgba(0,0,0,.45)',
  },
  overlayMsg: {
    position: 'absolute', bottom: 24, left: 0, right: 0, textAlign: 'center',
    color: C.lab, fontSize: 13, fontFamily: 'monospace',
  },
  torch: {
    position: 'absolute', bottom: 18, right: 18, background: 'rgba(0,0,0,.55)', color: C.lab,
    border: `1px solid ${C.slate}`, padding: '9px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  manualRow: { display: 'flex', gap: 8, padding: 12, background: C.ink },
  input: { flex: 1, padding: '12px', border: `1px solid ${C.slate}`, background: '#0A1F17', color: C.lab, fontSize: 14 },
  smallBtn: { padding: '12px 18px', background: C.neo, color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' },
  sheetWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'flex-end', zIndex: 60 },
  sheet: { width: '100%', background: '#fff', padding: '20px 18px 24px', maxHeight: '78vh', overflowY: 'auto' },
  sheetTitle: { fontSize: 18, fontWeight: 800, marginBottom: 6 },
  sheetHint: { fontSize: 13.5, color: C.slate, marginBottom: 14, lineHeight: 1.45 },
  kv: {
    display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 14px',
    fontSize: 13, marginBottom: 18, color: C.ink,
  },
  btnRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  bigBtn: { width: '100%', padding: '15px', border: 'none', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};
